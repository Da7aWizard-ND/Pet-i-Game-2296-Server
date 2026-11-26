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
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,23}$/;
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

function cleanPersonName(value) {
  const name = typeof value === "string" ? value.trim().normalize("NFC").replace(/\s+/gu, " ") : "";
  if (!name || [...name].length > 80 || !/\p{L}/u.test(name)
    || /[^\p{L}\p{M} .'\u2019\u02BC\u2010-\u2015-]/u.test(name)) return "";
  return name;
}

function cleanCountry(value) {
  const country = typeof value === "string" ? value.trim().normalize("NFC").replace(/\s+/gu, " ") : "";
  if ([...country].length < 2 || [...country].length > 80 || !/\p{L}/u.test(country)
    || /[\p{Cc}\p{Cf}]/u.test(country)) return "";
  return country;
}

function ageFromDateOfBirth(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return -1;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1900) return -1;
  const birthDate = new Date(Date.UTC(year, month - 1, day));
  if (birthDate.getUTCFullYear() !== year || birthDate.getUTCMonth() !== month - 1
    || birthDate.getUTCDate() !== day) return -1;
  const today = new Date();
  let age = today.getUTCFullYear() - year;
  if (today.getUTCMonth() + 1 < month
    || (today.getUTCMonth() + 1 === month && today.getUTCDate() < day)) age--;
  return age >= 0 && age <= 120 ? age : -1;
}

function cleanRegistrationDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const username = typeof value.username === "string" ? value.username.trim() : "";
  const firstName = cleanPersonName(value.first_name);
  const surname = cleanPersonName(value.surname);
  const country = cleanCountry(value.country);
  const age = value.age;
  const dateOfBirth = typeof value.date_of_birth === "string" ? value.date_of_birth.trim() : "";
  if (!USERNAME_PATTERN.test(username) || !firstName || !surname || !country
    || !Number.isSafeInteger(age) || age < 0 || age > 120 || ageFromDateOfBirth(dateOfBirth) !== age) {
    return null;
  }
  return { username, firstName, surname, country, age, dateOfBirth };
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
  store, clients = new Map(), send, error, log = console.log, mailer = null, secret = "",
  onPasswordReset = () => {},
}) {
  const sessionIndex = new Map();
  const limits = new Map();
  const ADMIN_USER_PAGE_SIZE = 25;
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

  function usernameTaken(username, ignoredKeys = []) {
    const ignored = new Set(ignoredKeys.filter(Boolean));
    const normalized = username.toLowerCase();
    for (const [key, account] of store.accounts) {
      if (ignored.has(key)) continue;
      if (typeof account.username === "string" && account.username.toLowerCase() === normalized) return true;
    }
    return false;
  }

  function activateAccount(account) {
    if (!account.verifiedAt) account.verifiedAt = Date.now();
    account.codeHash = "";
    account.codeExpiresAt = 0;
    account.verifyAttempts = 0;
    if (!account.rewardGranted) {
      account.profile.bolts = Math.min(1_000_000_000, account.profile.bolts + BONUS_BOLTS);
      account.rewardGranted = true;
      account.rewardGrantedAt = Date.now();
    }
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

  function getProfileRevision(account) {
    return Number.isSafeInteger(account.profileRevision) && account.profileRevision >= 0
      ? account.profileRevision : 0;
  }

  function accountForSession(token, secure) {
    if (!secure || typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) return null;
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const key = sessionIndex.get(hash);
    const account = key ? store.accounts.get(key) : null;
    const session = account && (account.sessions || []).find((item) => item.hash === hash);
    if (!account || !account.verifiedAt || account.suspendedAt || !session) {
      sessionIndex.delete(hash);
      return null;
    }
    if (session.expiresAt && session.expiresAt <= Date.now()) {
      account.sessions = account.sessions.filter((item) => item.hash !== hash);
      sessionIndex.delete(hash);
      store.touchAccount(account);
      return null;
    }
    return {
      key, email: account.email, pid: account.pid, profile: account.profile,
      profileRevision: getProfileRevision(account),
    };
  }

  function restoreSession(c, token) {
    const session = accountForSession(token, c.secure);
    if (!session) return null;
    c.account = session.key;
    c.accountToken = token;
    c.pid = session.pid;
    return { email: session.email, profile: session.profile, profileRevision: session.profileRevision };
  }

  async function authenticate(emailValue, passwordValue, {
    secure, ip, client = null, remember = null, profileValue = null,
  } = {}) {
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
    const storedHash = account && account.passwordHash ? account.passwordHash : await DUMMY_PASSWORD_HASH;
    const matches = password.length <= 128 && await verifyPassword(password, storedHash);
    if (!account || !matches) {
      return { ok: false, code: "account_login", message: "Email or password is incorrect." };
    }
    if (account.suspendedAt) {
      return { ok: false, code: "account_suspended", message: "This account is suspended. Contact the game administrator." };
    }
    let profileLink = null;
    if (client && account.websiteRegistrationPending) {
      const pid = typeof client.localPid === "string" && client.localPid
        ? client.localPid : typeof client.pid === "string" ? client.pid : "";
      const profile = cleanProfile(profileValue);
      if (!pid || !profile) {
        return {
          ok: false,
          code: "account_profile",
          message: "Update the game before signing in so your local profile can be linked safely.",
        };
      }
      if (linkedAccount(pid, key)) {
        return {
          ok: false,
          code: "account_profile_linked",
          message: "This game profile is already linked to another account.",
        };
      }
      profileLink = {
        pid: account.pid,
        profile: account.profile,
        profileRevision: account.profileRevision,
        profileUpdatedAt: account.profileUpdatedAt,
        websiteRegistrationPending: account.websiteRegistrationPending,
      };
      profile.bolts = Math.min(1_000_000_000, profile.bolts + BONUS_BOLTS);
      account.pid = pid;
      account.profile = profile;
      account.profileRevision = 0;
      account.profileUpdatedAt = Date.now();
      account.websiteRegistrationPending = false;
    }
    if (!account.verifiedAt) {
      activateAccount(account);
      store.touchAccount(account);
    }
    const sessionClient = client || {};
    const ttl = remember === null ? 0 : remember ? SESSION_TTL : SESSION_ONLY_TTL;
    const previousSessions = (account.sessions || []).slice();
    const previousClientState = client ? {
      account: client.account,
      accountToken: client.accountToken,
      accountExpiresAt: client.accountExpiresAt,
      pid: client.pid,
    } : null;
    const token = makeSession(sessionClient, account, key, ttl);
    if (!await store.flush()) {
      sessionIndex.delete(crypto.createHash("sha256").update(token).digest("hex"));
      account.sessions = previousSessions;
      for (const [hash, accountKey] of sessionIndex) {
        if (accountKey === key) sessionIndex.delete(hash);
      }
      for (const session of previousSessions) sessionIndex.set(session.hash, key);
      if (profileLink) {
        account.pid = profileLink.pid;
        account.profile = profileLink.profile;
        if (profileLink.profileRevision === undefined) delete account.profileRevision;
        else account.profileRevision = profileLink.profileRevision;
        if (profileLink.profileUpdatedAt === undefined) delete account.profileUpdatedAt;
        else account.profileUpdatedAt = profileLink.profileUpdatedAt;
        account.websiteRegistrationPending = profileLink.websiteRegistrationPending;
      }
      if (previousClientState) {
        for (const [field, value] of Object.entries(previousClientState)) {
          if (value === undefined) delete client[field];
          else client[field] = value;
        }
      }
      store.touchAccount(account);
      return { ok: false, code: "account_storage", message: "Your sign-in could not be saved. Please try again." };
    }
    return {
      ok: true, email, token, expiresAt: sessionClient.accountExpiresAt, profile: account.profile,
      profileRevision: getProfileRevision(account),
    };
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
      const delivery = await mailer.sendMail({
        to: email,
        subject: "Reset your i-Pet account password",
        text: `Your i-Pet Cyber Store 2096 password reset code is ${code}.\n\nIt expires in 15 minutes. If you did not request this, you can ignore this email.`,
      });
      if (delivery && delivery.messageId) log("password reset email accepted by gateway:", delivery.messageId);
    } catch (e) {
      log("password reset email delivery failed:", e instanceof Error ? e.message : "Unknown email gateway error");
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
    const previousPasswordHash = account.passwordHash;
    const previousCodeHash = account.codeHash;
    const previousCodeExpiresAt = account.codeExpiresAt;
    const previousVerifyAttempts = account.verifyAttempts;
    const previousSessions = (account.sessions || []).slice();
    account.passwordHash = passwordHashValue;
    account.codeHash = "";
    account.codeExpiresAt = 0;
    account.verifyAttempts = 0;
    for (const session of account.sessions || []) sessionIndex.delete(session.hash);
    account.sessions = [];
    store.touchAccount(account);
    onPasswordReset(key);
    if (!await store.flush()) {
      account.passwordHash = previousPasswordHash;
      account.codeHash = previousCodeHash;
      account.codeExpiresAt = previousCodeExpiresAt;
      account.verifyAttempts = previousVerifyAttempts;
      account.sessions = previousSessions;
      for (const session of previousSessions) sessionIndex.set(session.hash, key);
      store.touchAccount(account);
      return { ok: false, code: "account_storage" };
    }
    return { ok: true };
  }

  async function register(c, m) {
    if (!canUseAccount(c)) return;
    if (c.account) return error(c, "account_signed_in", "Sign out before registering another account.");
    const email = normalizeEmail(m.email);
    const password = typeof m.password === "string" ? m.password : "";
    const profile = cleanProfile(m.profile);
    const details = cleanRegistrationDetails(m);
    if (!email) return error(c, "account_input", "Enter a valid email address.");
    if (password.length < 10 || password.length > 128) {
      return error(c, "account_input", "Password must be between 10 and 128 characters.");
    }
    if (!profile) {
      return error(c, "account_input", "Your game profile could not be validated. Restart the game and try again.");
    }
    if (!c.pid) {
      return error(c, "account_input", "Your player profile is not ready. Reconnect to the server and try again.");
    }
    if (!details) {
      return error(c, "account_input", "Check your username, names, country, age, and date of birth. Age must match date of birth.");
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
    if (account && (account.verifiedAt || account.pid !== c.pid)) {
      return error(c, "account_exists", "That email cannot be registered here. Try signing in instead.");
    }
    if (usernameTaken(details.username, [key, linked && linked.emailKey])) {
      return error(c, "account_username", "That username is already in use.");
    }
    const passwordHashValue = await hashPassword(password);
    linked = linkedAccount(c.pid, key);
    if (linked && linked.verifiedAt) {
      return error(c, "account_profile_linked", "This profile already has an account registration in progress or completed.");
    }
    account = store.accounts.get(key);
    if (account && (account.verifiedAt || account.pid !== c.pid)) {
      return error(c, "account_exists", "That email cannot be registered here. Try signing in instead.");
    }
    if (usernameTaken(details.username, [key, linked && linked.emailKey])) {
      return error(c, "account_username", "That username is already in use.");
    }
    const previousLinked = linked
      ? { key: linked.emailKey, account: { ...linked, sessions: (linked.sessions || []).slice() } }
      : null;
    if (linked) store.dropAccount(linked.emailKey);
    account = store.accounts.get(key);
    const previousAccount = account ? { ...account, sessions: (account.sessions || []).slice() } : null;
    if (!account) {
      account = {
        email, emailKey: key, pid: c.pid, passwordHash: passwordHashValue, profile,
        ...details, verifiedAt: 0, rewardGranted: false, sessions: [], createdAt: Date.now(),
      };
      store.accounts.set(key, account);
    } else {
      account.passwordHash = passwordHashValue;
      account.profile = profile;
      Object.assign(account, details);
    }
    activateAccount(account);
    store.touchAccount(account);
    const token = makeSession(c, account, key);
    if (!await store.flush()) {
      const sessionHash = crypto.createHash("sha256").update(token).digest("hex");
      sessionIndex.delete(sessionHash);
      c.account = null;
      c.accountToken = "";
      c.accountExpiresAt = 0;
      c.pid = c.localPid || c.pid;
      if (previousAccount) {
        Object.assign(account, previousAccount);
        store.accounts.set(key, account);
        store.touchAccount(account);
      } else {
        store.dropAccount(key);
      }
      if (previousLinked) {
        store.accounts.set(previousLinked.key, previousLinked.account);
        store.touchAccount(previousLinked.account);
      }
      return error(c, "account_storage", "Your account could not be saved. Please try again.");
    }
    send(c, {
      t: "account", event: "signed_in", email, token, profile: account.profile,
      profile_revision: getProfileRevision(account), new_account: true, reward: BONUS_BOLTS,
    });
  }

  async function registerWebsite(m, { secure, ip, remember = false } = {}) {
    if (!secure) {
      return { ok: false, code: "account_secure", message: "Account actions need a secure connection." };
    }
    const email = normalizeEmail(m.email);
    const password = typeof m.password === "string" ? m.password : "";
    const details = cleanRegistrationDetails(m);
    if (!email) return { ok: false, code: "account_input", message: "Enter a valid email address." };
    if (password.length < 10 || password.length > 128) {
      return { ok: false, code: "account_input", message: "Password must be between 10 and 128 characters." };
    }
    if (!details) {
      return {
        ok: false,
        code: "account_input",
        message: "Check your username, names, country, age, and date of birth. Age must match date of birth.",
      };
    }
    const key = emailKey(email);
    if (!limited(`register-ip:${ip}`, 5, 60 * 60 * 1000)
      || !limited(`register-email:${key}`, 3, 60 * 60 * 1000)) {
      return { ok: false, code: "account_rate", message: "Too many registration attempts. Please wait before trying again." };
    }
    if (store.accounts.has(key)) {
      return { ok: false, code: "account_exists", message: "An account with this email already exists. Sign in instead." };
    }
    if (usernameTaken(details.username)) {
      return { ok: false, code: "account_username", message: "That username is already in use." };
    }

    const passwordHashValue = await hashPassword(password);
    if (store.accounts.has(key)) {
      return { ok: false, code: "account_exists", message: "An account with this email already exists. Sign in instead." };
    }
    if (usernameTaken(details.username)) {
      return { ok: false, code: "account_username", message: "That username is already in use." };
    }

    let pid;
    do {
      pid = crypto.randomBytes(12).toString("hex");
    } while ((store.players && store.players.has(pid)) || linkedAccount(pid));
    const account = {
      email, emailKey: key, pid, passwordHash: passwordHashValue,
      profile: { version: 1, species: 0, bolts: BONUS_BOLTS },
      ...details, verifiedAt: Date.now(), rewardGranted: true, sessions: [], createdAt: Date.now(),
      websiteRegistrationPending: true,
    };
    store.accounts.set(key, account);
    const sessionClient = {};
    const ttl = remember ? SESSION_TTL : SESSION_ONLY_TTL;
    const token = makeSession(sessionClient, account, key, ttl);
    if (!await store.flush()) {
      sessionIndex.delete(crypto.createHash("sha256").update(token).digest("hex"));
      store.dropAccount(key);
      return { ok: false, code: "account_storage", message: "Your account could not be saved. Please try again." };
    }
    return { ok: true, email, token, expiresAt: sessionClient.accountExpiresAt };
  }

  async function login(c, m) {
    if (!canUseAccount(c)) return;
    if (c.account) return error(c, "account_signed_in", "You are already signed in.");
    const result = await authenticate(m.email, m.password, {
      secure: c.secure, ip: c.ip, client: c, profileValue: m.profile,
    });
    if (!result.ok) return error(c, result.code, result.message);
    send(c, {
      t: "account", event: "signed_in", email: result.email, token: result.token,
      profile: result.profile, profile_revision: result.profileRevision,
    });
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
    const profileRevision = getProfileRevision(account);
    const submittedRevision = Number.isSafeInteger(m.profile_revision) && m.profile_revision >= 0
      ? m.profile_revision : 0;
    if (submittedRevision !== profileRevision) {
      send(c, {
        t: "account", event: "profile_admin_updated",
        profile: account.profile, profile_revision: profileRevision,
      });
      return error(c, "account_sync_revision", "The server profile changed. The latest profile is being restored.");
    }
    const previousProfile = account.profile;
    const previousUpdatedAt = account.profileUpdatedAt;
    account.profile = profile;
    account.profileUpdatedAt = Date.now();
    store.touchAccount(account);
    if (!await store.flush()) {
      account.profile = previousProfile;
      if (previousUpdatedAt === undefined) delete account.profileUpdatedAt;
      else account.profileUpdatedAt = previousUpdatedAt;
      store.touchAccount(account);
      return error(c, "account_storage", "The server could not save your profile. It will retry.");
    }
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

  function adminUserView(account, includeProfile = false) {
    const profile = account.profile && typeof account.profile === "object" ? account.profile : {};
    const view = {
      email: account.email,
      username: String(account.username || ""),
      pid: account.pid,
      active: Boolean(account.verifiedAt),
      activatedAt: Number(account.verifiedAt) || 0,
      suspendedAt: Number(account.suspendedAt) || 0,
      createdAt: Number(account.createdAt) || 0,
      profileUpdatedAt: Number(account.profileUpdatedAt) || 0,
      profileRevision: getProfileRevision(account),
      rewardGranted: Boolean(account.rewardGranted),
      sessionCount: Array.isArray(account.sessions) ? account.sessions.length : 0,
      bolts: Number(profile.bolts) || 0,
      species: Number(profile.species) || 0,
    };
    if (includeProfile) {
      view.profile = profile;
      view.firstName = String(account.firstName || "");
      view.surname = String(account.surname || "");
      view.country = String(account.country || "");
      view.age = Number.isSafeInteger(account.age) ? account.age : null;
      view.dateOfBirth = String(account.dateOfBirth || "");
    }
    return view;
  }

  function requireAdmin(c) {
    if (c.admin) return true;
    error(c, "admin", "Not allowed.");
    return false;
  }

  function accountForAdmin(c, emailValue) {
    if (!requireAdmin(c)) return null;
    const email = normalizeEmail(emailValue);
    if (!email) {
      error(c, "admin_user_input", "Enter a valid account email address.");
      return null;
    }
    const key = emailKey(email);
    const account = store.accounts.get(key);
    if (!account) {
      error(c, "admin_user_missing", "That user account was not found.");
      return null;
    }
    return { key, account };
  }

  function signOutAccountClients(key) {
    for (const client of clients.values()) {
      if (client.account !== key) continue;
      client.account = null;
      client.accountToken = "";
      client.accountExpiresAt = 0;
      client.pid = client.localPid || client.pid;
      send(client, { t: "account", event: "signed_out" });
    }
  }

  function revokeAccountSessions(account) {
    for (const session of account.sessions || []) sessionIndex.delete(session.hash);
    account.sessions = [];
  }

  async function adminUserList(c, m) {
    if (!requireAdmin(c)) return;
    const query = typeof m.query === "string" ? m.query.trim().toLowerCase().slice(0, 128) : "";
    const matches = [...store.accounts.values()]
      .filter((account) => !query
        || String(account.email || "").toLowerCase().includes(query)
        || String(account.username || "").toLowerCase().includes(query)
        || String(account.pid || "").toLowerCase().includes(query))
      .sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")));
    const total = matches.length;
    const lastPage = Math.max(0, Math.ceil(total / ADMIN_USER_PAGE_SIZE) - 1);
    const page = Math.min(Number.isSafeInteger(m.page) ? Math.max(0, m.page) : 0, lastPage);
    const users = matches.slice(page * ADMIN_USER_PAGE_SIZE, (page + 1) * ADMIN_USER_PAGE_SIZE)
      .map((account) => adminUserView(account));
    send(c, { t: "admin_users", action: "list", query, page, page_size: ADMIN_USER_PAGE_SIZE, total, users });
  }

  function adminUserGet(c, m) {
    const found = accountForAdmin(c, m.email);
    if (!found) return;
    send(c, { t: "admin_users", action: "detail", user: adminUserView(found.account, true) });
  }

  async function adminUserUpdate(c, m) {
    const found = accountForAdmin(c, m.email);
    if (!found) return;
    const profile = cleanProfile(m.profile);
    if (!profile) return error(c, "admin_user_profile", "That profile is invalid.");
    const previousProfile = found.account.profile;
    const previousUpdatedAt = found.account.profileUpdatedAt;
    const previousRevision = found.account.profileRevision;
    found.account.profile = profile;
    found.account.profileUpdatedAt = Date.now();
    found.account.profileRevision = getProfileRevision(found.account) + 1;
    store.touchAccount(found.account);
    if (!await store.flush()) {
      found.account.profile = previousProfile;
      if (previousUpdatedAt === undefined) delete found.account.profileUpdatedAt;
      else found.account.profileUpdatedAt = previousUpdatedAt;
      if (previousRevision === undefined) delete found.account.profileRevision;
      else found.account.profileRevision = previousRevision;
      store.touchAccount(found.account);
      return error(c, "admin_user_storage", "The profile could not be saved. Please try again.");
    }
    for (const client of clients.values()) {
      if (client.account === found.key) {
        send(client, {
          t: "account", event: "profile_admin_updated",
          profile, profile_revision: found.account.profileRevision,
        });
      }
    }
    log(`admin ${c.tag} updated profile for player ${found.account.pid}`);
    send(c, { t: "admin_users", action: "updated", user: adminUserView(found.account, true) });
  }

  async function adminUserSuspend(c, m) {
    const found = accountForAdmin(c, m.email);
    if (!found) return;
    if (typeof m.suspended !== "boolean") {
      return error(c, "admin_user_input", "Choose whether to suspend this account.");
    }
    if (m.suspended && c.account === found.key) {
      return error(c, "admin_user_self", "You cannot suspend your own account.");
    }
    const account = found.account;
    const previousSuspendedAt = account.suspendedAt;
    const previousSessions = Array.isArray(account.sessions) ? account.sessions.slice() : [];
    if (m.suspended) {
      account.suspendedAt = Date.now();
      account.sessions = [];
    } else {
      delete account.suspendedAt;
    }
    store.touchAccount(account);
    if (!await store.flush()) {
      if (previousSuspendedAt === undefined) delete account.suspendedAt;
      else account.suspendedAt = previousSuspendedAt;
      account.sessions = previousSessions;
      store.touchAccount(account);
      return error(c, "admin_user_storage", "The account status could not be saved. Please try again.");
    }
    if (m.suspended) {
      for (const session of previousSessions) sessionIndex.delete(session.hash);
      signOutAccountClients(found.key);
    }
    log(`admin ${c.tag} ${m.suspended ? "suspended" : "restored"} player ${account.pid}`);
    send(c, { t: "admin_users", action: "status", user: adminUserView(account) });
  }

  async function adminUserDelete(c, m) {
    const found = accountForAdmin(c, m.email);
    if (!found) return;
    if (c.account === found.key) return error(c, "admin_user_self", "You cannot delete your own account.");
    const account = found.account;
    store.dropAccount(found.key);
    if (!await store.flush()) {
      store.accounts.set(found.key, account);
      store.touchAccount(account);
      return error(c, "admin_user_storage", "The account could not be deleted. Please try again.");
    }
    revokeAccountSessions(account);
    signOutAccountClients(found.key);
    log(`admin ${c.tag} deleted account for player ${account.pid}`);
    send(c, { t: "admin_users", action: "deleted", email: account.email, pid: account.pid });
  }

  const handlers = {
    account_register: register,
    account_login: login,
    account_sync: sync,
    account_logout: logout,
    admin_user_list: adminUserList,
    admin_user_get: adminUserGet,
    admin_user_update: adminUserUpdate,
    admin_user_suspend: adminUserSuspend,
    admin_user_delete: adminUserDelete,
  };

  return {
    handlers, restoreSession, authenticate, accountForSession, revokeSession,
    requestPasswordReset, resetPassword, registerWebsite,
  };
}

module.exports = { createAccounts, cleanProfile, normalizeEmail, hashPassword, verifyPassword, BONUS_BOLTS };
