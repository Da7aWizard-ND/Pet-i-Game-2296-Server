"use strict";

const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(24).toString("hex"));
const EMAIL_CODE_TTL = 15 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const SESSION_ONLY_TTL = 12 * 60 * 60 * 1000;
const PROFILE_MAX_BYTES = 32 * 1024;
const BONUS_BOLTS = 250;
const PROFILE_KEYS = new Set([
  "version", "species", "record", "daily", "bonus", "guide_done", "ctf_guide_done",
  "bolts", "vend_passes", "wardrobe_owned", "outfit", "specials", "lifetime", "badges",
  "specials_seen", "special_equipped", "special_daily",
]);

function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function emailKey(email) {
  return crypto.createHash("sha256").update(email).digest("hex");
}

function boundedClone(value, depth = 0, budget = { count: 0 }) {
  if (++budget.count > 5000 || depth > 10) throw new Error("profile_complex");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("profile_number");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 512) throw new Error("profile_string");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error("profile_array");
    return value.map((item) => boundedClone(item, depth + 1, budget));
  }
  if (!value || typeof value !== "object") throw new Error("profile_value");
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_:-]{1,64}$/.test(key) || key === "__proto__" || key === "constructor") {
      throw new Error("profile_key");
    }
    result[key] = boundedClone(item, depth + 1, budget);
  }
  return result;
}

function cleanProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return null;
  try {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (!PROFILE_KEYS.has(key)) continue;
      result[key] = boundedClone(item);
    }
    if (!Number.isInteger(result.bolts) || result.bolts < 0 || result.bolts > 1_000_000_000) return null;
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > PROFILE_MAX_BYTES) return null;
    return result;
  } catch {
    return null;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!/^[a-f0-9]{32}$/i.test(saltHex || "") || !/^[a-f0-9]{128}$/i.test(hashHex || "")) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(actual, expected);
}

function createAccounts({
  store, send, error, log = console.log, mailer = null, mailFrom = "", secret = "",
  onPasswordReset = () => {},
}) {
  const sessionIndex = new Map();
  const limits = new Map();
  for (const [key, account] of store.accounts) {
    for (const session of account.sessions || []) sessionIndex.set(session.hash, key);
  }

  function limited(key, maximum, windowMs) {
    const now = Date.now();
    let bucket = limits.get(key);
    if (!bucket || bucket.until <= now) {
      bucket = { count: 0, until: now + windowMs };
      limits.set(key, bucket);
    }
    if (bucket.count >= maximum) return false;
    bucket.count++;
    if (limits.size > 10000) {
      for (const [id, value] of limits) if (value.until <= now) limits.delete(id);
    }
    return true;
  }

  function canUseAccount(c) {
    if (!c.secure) {
      error(c, "account_secure", "Account actions need a secure connection. Use the server's wss:// address.");
      return false;
    }
    return true;
  }

  function codeHash(email, code) {
    return crypto.createHmac("sha256", secret).update(`${email}:${code}`).digest("hex");
  }

  function linkedAccount(pid, exceptKey = "") {
    for (const [key, account] of store.accounts) {
      if (key !== exceptKey && account.pid === pid) return account;
    }
    return null;
  }

  function makeSession(c, account, key, ttl = 0) {
    const token = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = ttl > 0 ? Date.now() + ttl : 0;
    account.sessions = (account.sessions || []).filter((item) => item.hash !== hash);
    account.sessions.push({ hash, createdAt: Date.now(), expiresAt });
    while (account.sessions.length > 8) {
      const expired = account.sessions.shift();
      sessionIndex.delete(expired.hash);
    }
    sessionIndex.set(hash, key);
    c.account = key;
    c.accountToken = token;
    c.pid = account.pid;
    c.accountExpiresAt = expiresAt;
    store.touchAccount(account);
    return token;
  }

  function accountForSession(token, secure) {
    if (!secure || typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) return null;
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const key = sessionIndex.get(hash);
    const account = key ? store.accounts.get(key) : null;
    const session = account && (account.sessions || []).find((item) => item.hash === hash);
    if (!account || !account.verifiedAt || !session) {
      sessionIndex.delete(hash);
      return null;
    }
    if (session.expiresAt && session.expiresAt <= Date.now()) {
      account.sessions = account.sessions.filter((item) => item.hash !== hash);
      sessionIndex.delete(hash);
      store.touchAccount(account);
      return null;
    }
    return { key, email: account.email, pid: account.pid, profile: account.profile };
  }

  function restoreSession(c, token) {
    const session = accountForSession(token, c.secure);
    if (!session) return null;
    c.account = session.key;
    c.accountToken = token;
    c.pid = session.pid;
    return { email: session.email, profile: session.profile };
  }

  async function authenticate(emailValue, passwordValue, { secure, ip, client = null, remember = null } = {}) {
    if (!secure) {
      return { ok: false, code: "account_secure", message: "Account actions need a secure connection." };
    }
    const email = normalizeEmail(emailValue);
    const password = typeof passwordValue === "string" ? passwordValue : "";
    const key = email ? emailKey(email) : "";
    if (!limited(`login-ip:${ip}`, 12, 15 * 60 * 1000)
      || !limited(`login-email:${key}`, 8, 15 * 60 * 1000)) {
      return { ok: false, code: "account_rate", message: "Too many sign-in attempts. Please wait before trying again." };
    }
    const account = key ? store.accounts.get(key) : null;
    const storedHash = account && account.verifiedAt
      ? account.passwordHash
      : await DUMMY_PASSWORD_HASH;
    const matches = password.length <= 128 && await verifyPassword(password, storedHash);
    if (!matches) {
      return { ok: false, code: "account_login", message: "Email or password is incorrect, or the email is not verified." };
    }
    const sessionClient = client || {};
    const ttl = remember === null ? 0 : remember ? SESSION_TTL : SESSION_ONLY_TTL;
    const token = makeSession(sessionClient, account, key, ttl);
    if (!await store.flush()) {
      return { ok: false, code: "account_storage", message: "Your sign-in could not be saved. Please try again." };
    }
    return { ok: true, email, token, expiresAt: sessionClient.accountExpiresAt, profile: account.profile };
  }

  async function revokeSession(token, secure) {
    if (!secure || typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) return true;
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const key = sessionIndex.get(hash);
    const account = key ? store.accounts.get(key) : null;
    if (!account || !(account.sessions || []).some((session) => session.hash === hash)) {
      sessionIndex.delete(hash);
      return true;
    }
    account.sessions = account.sessions.filter((session) => session.hash !== hash);
    sessionIndex.delete(hash);
    store.touchAccount(account);
    return store.flush();
  }

  async function requestPasswordReset(emailValue, { secure, ip } = {}) {
    if (!secure) return { ok: false, code: "account_secure" };
    if (!mailer || typeof mailer.sendMail !== "function" || secret.length < 32) {
      return { ok: false, code: "account_unconfigured" };
    }
    const email = normalizeEmail(emailValue);
    const key = email ? emailKey(email) : "";
    if (!limited(`reset-ip:${ip}`, 5, 60 * 60 * 1000)
      || !limited(`reset-email:${key || "invalid"}`, 3, 60 * 60 * 1000)) {
      return { ok: false, code: "account_rate" };
    }
    const account = key ? store.accounts.get(key) : null;
    if (!account || !account.verifiedAt) return { ok: true };

    const code = String(crypto.randomInt(100000, 1000000));
    account.codeHash = codeHash(email, code);
    account.codeExpiresAt = Date.now() + EMAIL_CODE_TTL;
    account.verifyAttempts = 0;
    store.touchAccount(account);
    if (!await store.flush()) return { ok: false, code: "account_storage" };
    try {
      await mailer.sendMail({
        from: mailFrom,
        to: email,
        subject: "Reset your i-Pet account password",
        text: `Your i-Pet Cyber Store 2096 password reset code is ${code}.\n\nIt expires in 15 minutes. If you did not request this, you can ignore this email.`,
      });
    } catch (e) {
      log("password reset email delivery failed:", e && e.code ? e.code : "smtp_error");
      return { ok: false, code: "email_failed" };
    }
    return { ok: true };
  }

  async function resetPassword(emailValue, codeValue, passwordValue, { secure, ip } = {}) {
    if (!secure) return { ok: false, code: "account_secure" };
    const email = normalizeEmail(emailValue);
    const code = typeof codeValue === "string" ? codeValue.trim() : "";
    const password = typeof passwordValue === "string" ? passwordValue : "";
    if (!email || !/^\d{6}$/.test(code) || password.length < 10 || password.length > 128) {
      return { ok: false, code: "account_reset_input" };
    }
    const key = emailKey(email);
    if (!limited(`reset-confirm-ip:${ip}`, 10, 30 * 60 * 1000)
      || !limited(`reset-confirm-email:${key}`, 8, 30 * 60 * 1000)) {
      return { ok: false, code: "account_rate" };
    }
    const account = store.accounts.get(key);
    const expected = Buffer.from(account && account.verifiedAt && account.codeHash
      ? account.codeHash
      : codeHash(email, "000000"), "hex");
    const actual = Buffer.from(codeHash(email, code), "hex");
    const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!account || !account.verifiedAt || !matches || account.codeExpiresAt <= Date.now()
      || (account.verifyAttempts || 0) >= 8) {
      if (account && account.verifiedAt) {
        account.verifyAttempts = (account.verifyAttempts || 0) + 1;
        store.touchAccount(account);
        if (!await store.flush()) return { ok: false, code: "account_storage" };
      }
      return { ok: false, code: "account_reset_invalid" };
    }

    const passwordHashValue = await hashPassword(password);
    account.passwordHash = passwordHashValue;
    account.codeHash = "";
    account.codeExpiresAt = 0;
    account.verifyAttempts = 0;
    for (const session of account.sessions || []) sessionIndex.delete(session.hash);
    account.sessions = [];
    store.touchAccount(account);
    onPasswordReset(key);
    if (!await store.flush()) return { ok: false, code: "account_storage" };
    return { ok: true };
  }

  async function sendVerification(c, account) {
    if (!mailer || typeof mailer.sendMail !== "function") {
      return error(c, "email_unconfigured", "Email delivery is not configured on this server.");
    }
    if (secret.length < 32) {
      return error(c, "account_unconfigured", "Account verification is not configured on this server.");
    }
    const code = String(crypto.randomInt(100000, 1000000));
    account.codeHash = codeHash(account.email, code);
    account.codeExpiresAt = Date.now() + EMAIL_CODE_TTL;
    account.verifyAttempts = 0;
    store.touchAccount(account);
    if (!await store.flush()) {
      return error(c, "account_storage", "The server could not save your registration. Please try again.");
    }
    try {
      await mailer.sendMail({
        from: mailFrom,
        to: account.email,
        subject: "Your i-Pet account verification code",
        text: `Your i-Pet Cyber Store 2096 verification code is ${code}.\n\nIt expires in 15 minutes. If you did not request this, you can ignore this email.`,
      });
    } catch (e) {
      log("account email delivery failed:", e && e.code ? e.code : "smtp_error");
      return error(c, "email_failed", "The verification email could not be sent. Check the server mail settings and try again.");
    }
    send(c, { t: "account", event: "verification_sent", email: account.email });
  }

  async function register(c, m) {
    if (!canUseAccount(c)) return;
    if (c.account) return error(c, "account_signed_in", "Sign out before registering another account.");
    if (!mailer || typeof mailer.sendMail !== "function") {
      return error(c, "email_unconfigured", "Email delivery is not configured on this server.");
    }
    if (secret.length < 32) {
      return error(c, "account_unconfigured", "Account verification is not configured on this server.");
    }
    const email = normalizeEmail(m.email);
    const password = typeof m.password === "string" ? m.password : "";
    const profile = cleanProfile(m.profile);
    if (!email || password.length < 10 || password.length > 128 || !profile || !c.pid) {
      return error(c, "account_input", "Enter a valid email, a password of 10–128 characters, and connect your profile.");
    }
    const key = emailKey(email);
    if (!limited(`register-ip:${c.ip}`, 5, 60 * 60 * 1000)
      || !limited(`register-email:${key}`, 3, 60 * 60 * 1000)) {
      return error(c, "account_rate", "Too many registration attempts. Please wait before trying again.");
    }
    let account = store.accounts.get(key);
    let linked = linkedAccount(c.pid, key);
    if (linked && linked.verifiedAt) {
      return error(c, "account_profile_linked", "This profile already has an account registration in progress or completed.");
    }
    if (linked) store.dropAccount(linked.emailKey);
    if (account && (account.verifiedAt || account.pid !== c.pid)) {
      return error(c, "account_exists", "That email cannot be registered here. Try signing in instead.");
    }
    const passwordHashValue = await hashPassword(password);
    linked = linkedAccount(c.pid, key);
    if (linked && linked.verifiedAt) {
      return error(c, "account_profile_linked", "This profile already has an account registration in progress or completed.");
    }
    if (linked) store.dropAccount(linked.emailKey);
    account = store.accounts.get(key);
    if (account && (account.verifiedAt || account.pid !== c.pid)) {
      return error(c, "account_exists", "That email cannot be registered here. Try signing in instead.");
    }
    if (!account) {
      account = {
        email, emailKey: key, pid: c.pid, passwordHash: passwordHashValue, profile,
        verifiedAt: 0, rewardGranted: false, sessions: [], createdAt: Date.now(),
      };
      store.accounts.set(key, account);
    } else {
      account.passwordHash = passwordHashValue;
      account.profile = profile;
    }
    await sendVerification(c, account);
  }

  async function verify(c, m) {
    if (!canUseAccount(c)) return;
    if (secret.length < 32) return error(c, "account_unconfigured", "Account verification is not configured on this server.");
    const email = normalizeEmail(m.email);
    const code = typeof m.code === "string" ? m.code.trim() : "";
    if (!email || !/^\d{6}$/.test(code)) return error(c, "account_code", "Enter the email address and its six-digit code.");
    const key = emailKey(email);
    if (!limited(`verify-ip:${c.ip}`, 10, 30 * 60 * 1000)
      || !limited(`verify-email:${key}`, 8, 30 * 60 * 1000)) {
      return error(c, "account_rate", "Too many code attempts. Request a new code later.");
    }
    const account = store.accounts.get(key);
    if (!account || account.pid !== c.pid) return error(c, "account_code", "That code is invalid or expired.");
    if (!account.verifiedAt) {
      const expected = Buffer.from(account.codeHash || "", "hex");
      const actual = Buffer.from(codeHash(email, code), "hex");
      account.verifyAttempts = (account.verifyAttempts || 0) + 1;
      const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
        && account.codeExpiresAt > Date.now() && account.verifyAttempts <= 8;
      if (!valid) {
        store.touchAccount(account);
        await store.flush();
        return error(c, "account_code", "That code is invalid or expired. You can request another code.");
      }
      account.verifiedAt = Date.now();
      account.codeHash = "";
      account.codeExpiresAt = 0;
      if (!account.rewardGranted) {
        account.profile.bolts = Math.min(1_000_000_000, account.profile.bolts + BONUS_BOLTS);
        account.rewardGranted = true;
        account.rewardGrantedAt = Date.now();
      }
    }
    const token = makeSession(c, account, key);
    if (!await store.flush()) return error(c, "account_storage", "Your account could not be saved. Please sign in and try again.");
    send(c, { t: "account", event: "verified", email, token, profile: account.profile, reward: BONUS_BOLTS });
  }

  async function login(c, m) {
    if (!canUseAccount(c)) return;
    if (c.account) return error(c, "account_signed_in", "You are already signed in.");
    const result = await authenticate(m.email, m.password, { secure: c.secure, ip: c.ip, client: c });
    if (!result.ok) return error(c, result.code, result.message);
    send(c, { t: "account", event: "signed_in", email: result.email, token: result.token, profile: result.profile });
  }

  async function sync(c, m) {
    const account = c.account ? store.accounts.get(c.account) : null;
    if (!account || account.pid !== c.pid) return error(c, "account_required", "Sign in to sync your profile.");
    if (!Number.isSafeInteger(m.sync_id) || m.sync_id < 0) {
      return error(c, "account_profile", "The saved profile could not be synced.");
    }
    if (!limited(`sync:${c.account}:${c.ip}`, 2, 1000)) {
      return error(c, "account_sync_rate", "Profile sync is busy. Please wait a moment.");
    }
    const profile = cleanProfile(m.profile);
    if (!profile) return error(c, "account_profile", "The saved profile could not be synced.");
    account.profile = profile;
    account.profileUpdatedAt = Date.now();
    store.touchAccount(account);
    if (!await store.flush()) return error(c, "account_storage", "The server could not save your profile. It will retry.");
    send(c, { t: "account", event: "profile_saved", sync_id: m.sync_id });
  }

  async function logout(c) {
    const key = c.account;
    const account = key ? store.accounts.get(key) : null;
    if (account && c.accountToken) {
      const hash = crypto.createHash("sha256").update(c.accountToken).digest("hex");
      account.sessions = (account.sessions || []).filter((session) => session.hash !== hash);
      sessionIndex.delete(hash);
      store.touchAccount(account);
      if (!await store.flush()) return error(c, "account_storage", "Sign out could not be saved. Please try again.");
    }
    c.account = null;
    c.accountToken = "";
    c.pid = c.localPid || c.pid;
    send(c, { t: "account", event: "signed_out" });
  }

  const handlers = {
    account_register: register,
    account_verify: verify,
    account_login: login,
    account_sync: sync,
    account_logout: logout,
  };

  return {
    handlers, restoreSession, authenticate, accountForSession, revokeSession,
    requestPasswordReset, resetPassword,
  };
}

module.exports = { createAccounts, cleanProfile, normalizeEmail, hashPassword, verifyPassword, BONUS_BOLTS };
