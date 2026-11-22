"use strict";
// Gift codes: 12-digit, one-use codes that give bolts, a special item and/or a
// hat. Nigel makes them in the game's hidden admin panel; players type them in
// the Redeem box on their Profile page.
//
// The admin password is never in the game: the game sends what was typed and
// the server compares its hash with ADMIN_HASH (or the ADMIN_CODE_HASH
// environment variable, if set). To change the password, put the sha256 of
// "ipet-admin:" + the new password in ADMIN_CODE_HASH.
//
// Wrong guesses are limited (8 per 10 minutes per connection and per address),
// so a 12-digit code can't be found by trying them all.

const crypto = require("crypto");

const ADMIN_HASH = process.env.ADMIN_CODE_HASH || "011e657bd39861855579066768904194af5cae548e6afd68507c0cc3ea2e093c";
const EXPIRY = { "48h": 48 * 3600e3, "1w": 7 * 24 * 3600e3, "3m": 90 * 24 * 3600e3 };
const MAX_FAILS = 8;
const FAIL_WINDOW_MS = 10 * 60e3;
const MAX_MAKE = 20;          // codes per press
const KEEP_EXPIRED_MS = 30 * 24 * 3600e3;

function createCodes({ store, send, error, log, playerOf }) {
  const fails = new Map();    // "c:<id>" / "ip:<addr>" -> [times]

  function blocked(c) {
    const now = Date.now();
    for (const k of ["c:" + c.id, "ip:" + c.ip]) {
      const list = (fails.get(k) || []).filter((t) => now - t < FAIL_WINDOW_MS);
      fails.set(k, list);
      if (list.length >= MAX_FAILS) return true;
    }
    return false;
  }

  function failed(c) {
    for (const k of ["c:" + c.id, "ip:" + c.ip]) {
      const list = fails.get(k) || [];
      list.push(Date.now());
      fails.set(k, list);
    }
  }

  function hash(text) {
    return crypto.createHash("sha256").update("ipet-admin:" + text).digest("hex");
  }

  function newCode() {
    for (let i = 0; i < 50; i++) {
      let s = String(crypto.randomInt(1, 10));
      for (let j = 0; j < 11; j++) s += String(crypto.randomInt(0, 10));
      if (!store.codes.has(s)) return s;
    }
    return null;
  }

  // What a code gives, checked: bolts 0-10000, item "" / an item id / "random:<rarity>", hat "" / a hat id.
  function cleanReward(r) {
    r = r && typeof r === "object" ? r : {};
    const bolts = Math.max(0, Math.min(10000, Math.floor(Number(r.bolts) || 0)));
    let item = typeof r.item === "string" ? r.item : "";
    if (!/^(random:(common|rare|legendary)|[a-z]{2,12})?$/.test(item)) item = "";
    let hat = typeof r.hat === "string" ? r.hat : "";
    if (!/^[a-z]{0,12}$/.test(hat)) hat = "";
    const note = typeof r.note === "string" ? r.note.replace(/[^\w .,!?'-]/g, "").slice(0, 40) : "";
    return { bolts, item, hat, note };
  }

  function view(code) {
    const now = Date.now();
    const status = code.used ? "used" : code.expires < now ? "expired" : "ready";
    return { code: code.code, made: code.made, expires: code.expires, reward: code.reward, status,
      used_by: code.used ? code.used.tag : "", used_at: code.used ? code.used.at : 0 };
  }

  function recent() {
    const now = Date.now();
    for (const code of [...store.codes.values()]) {
      if (code.expires < now - KEEP_EXPIRED_MS) store.dropCode(code.code);
    }
    return [...store.codes.values()].sort((a, b) => b.made - a.made).slice(0, 40).map(view);
  }

  const handlers = {
    // A player types a code. Also how the admin panel is opened: anything that
    // isn't 12 digits is checked as the admin password.
    redeem(c, m) {
      const text = String(m.code || "").replace(/[\s-]/g, "").slice(0, 40);
      if (blocked(c)) return send(c, { t: "redeem", ok: false, why: "slow", text: "Too many tries. Wait a few minutes." });
      if (!/^\d{12}$/.test(text)) {
        if (text.length >= 6 && crypto.timingSafeEqual(Buffer.from(hash(text)), Buffer.from(ADMIN_HASH))) {
          c.admin = true;
          log(`admin panel opened by ${c.tag}`);
          return send(c, { t: "admin", ok: true, codes: recent() });
        }
        failed(c);
        return send(c, { t: "redeem", ok: false, why: "bad", text: "That code isn't right. Codes are 12 digits." });
      }
      const code = store.codes.get(text);
      if (!code) {
        failed(c);
        return send(c, { t: "redeem", ok: false, why: "bad", text: "That code isn't right. Check the digits and try again." });
      }
      if (code.used) return send(c, { t: "redeem", ok: false, why: "used", text: "That code has already been used." });
      if (code.expires < Date.now()) return send(c, { t: "redeem", ok: false, why: "expired", text: "That code has expired." });
      const p = playerOf(c);
      code.used = { pid: p ? p.pid : "", tag: c.tag || "?", at: Date.now() };
      store.touchCode(code);
      log(`code ${text.slice(0, 4)}… redeemed by ${c.tag}`);
      send(c, { t: "redeem", ok: true, reward: code.reward });
    },

    admin_make(c, m) {
      if (!c.admin) return error(c, "admin", "Not allowed.");
      const life = EXPIRY[m.expiry];
      if (!life) return error(c, "admin", "Pick 48 hours, 1 week or 3 months.");
      const n = Math.max(1, Math.min(MAX_MAKE, Math.floor(Number(m.count) || 1)));
      const reward = cleanReward(m.reward);
      const made = [];
      for (let i = 0; i < n; i++) {
        const s = newCode();
        if (!s) break;
        const code = { code: s, made: Date.now(), expires: Date.now() + life, reward, used: null };
        store.codes.set(s, code);
        store.touchCode(code);
        made.push(s);
      }
      log(`admin ${c.tag} made ${made.length} code(s), ${m.expiry}`);
      send(c, { t: "admin", ok: true, made, codes: recent() });
    },

    admin_list(c) {
      if (!c.admin) return error(c, "admin", "Not allowed.");
      send(c, { t: "admin", ok: true, codes: recent() });
    },
  };

  return { handlers, hash };
}

module.exports = { createCodes, EXPIRY };
