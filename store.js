"use strict";
// Saved data for online profiles, accounts, leaderboards and Packs.
//
// Everything lives in memory while the server runs (it's small: one record per
// player and per Pack) and is written out a few seconds after it changes.
//
// Where it's written:
//   * MySQL, when these environment variables are set. GoDaddy Node.js Hosting
//     sets DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD by itself for its
//     managed MySQL (because mysql2 is in package.json). Elsewhere you can set
//     those, or MYSQL_URL=mysql://user:pass@host:3306/dbname.
//     One table, made automatically:  ipet_kv (k VARCHAR(80) PRIMARY KEY, v MEDIUMTEXT).
//   * Otherwise a JSON file: DATA_DIR/ipet_data.json (DATA_DIR defaults to ./data).
//     Fine for testing; on hosting that wipes files when you upload a new
//     version, use MySQL so nothing is lost.

const fs = require("fs");
const path = require("path");

const SAVE_DELAY_MS = 5000;

class Store {
  constructor(log) {
    this.log = log || console.log;
    this.players = new Map(); // pid -> player record
    this.packs = new Map();   // pack id -> pack record
    this.codes = new Map();   // 12-digit gift code -> code record (codes.js)
    this.accounts = new Map(); // hashed email -> account record (accounts.js)
    this.meta = { week: null, season: null, champion: null, lastWeekPacks: [] };
    this._dirty = new Set();  // keys like "p:<pid>", "k:<id>", "meta"
    this._timer = null;
    this._flushing = null;
    this._db = null;
    this._file = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "ipet_data.json");
    this.kind = "file";
  }

  async open() {
    const url = process.env.MYSQL_URL || process.env.DATABASE_URL;
    if (url || process.env.DB_HOST) {
      try {
        const mysql = require("mysql2/promise");
        this._db = url && url.startsWith("mysql")
          ? mysql.createPool(url)
          : mysql.createPool({
              host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || "3306", 10),
              user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
              connectionLimit: 4,
            });
        await this._db.query("CREATE TABLE IF NOT EXISTS ipet_kv (k VARCHAR(80) PRIMARY KEY, v MEDIUMTEXT NOT NULL)");
        const [rows] = await this._db.query("SELECT k, v FROM ipet_kv");
        for (const r of rows) this._take(r.k, JSON.parse(r.v));
        this.kind = "mysql";
        this.log(`store: MySQL, ${this.players.size} players, ${this.packs.size} packs, ${this.accounts.size} accounts`);
        return;
      } catch (e) {
        this.log("store: MySQL not available, using the data file instead:", e.message);
        this._db = null;
      }
    }
    try {
      const all = JSON.parse(fs.readFileSync(this._file, "utf8"));
      for (const [k, v] of Object.entries(all)) this._take(k, v);
    } catch (e) {
      if (e.code !== "ENOENT") this.log("store: couldn't read the data file:", e.message);
    }
    this.log(`store: file ${this._file}, ${this.players.size} players, ${this.packs.size} packs, ${this.accounts.size} accounts`);
  }

  _take(k, v) {
    if (k === "meta") Object.assign(this.meta, v);
    else if (k.startsWith("p:")) this.players.set(k.slice(2), v);
    else if (k.startsWith("k:")) this.packs.set(k.slice(2), v);
    else if (k.startsWith("c:")) this.codes.set(k.slice(2), v);
    else if (k.startsWith("a:")) this.accounts.set(k.slice(2), v);
  }

  touchPlayer(p) { this._mark("p:" + p.pid); }
  touchPack(k) { this._mark("k:" + k.id); }
  touchMeta() { this._mark("meta"); }
  touchCode(c) { this._mark("c:" + c.code); }
  touchAccount(a) { this._mark("a:" + a.emailKey); }
  dropAccount(emailKey) {
    this.accounts.delete(emailKey);
    this._mark("a:" + emailKey);
  }
  dropCode(code) {
    this.codes.delete(code);
    this._mark("c:" + code);
  }
  dropPack(id) {
    this.packs.delete(id);
    this._mark("k:" + id);
  }

  _mark(key) {
    this._dirty.add(key);
    if (!this._timer) this._timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  _value(key) {
    if (key === "meta") return this.meta;
    if (key.startsWith("p:")) return this.players.get(key.slice(2));
    if (key.startsWith("k:")) return this.packs.get(key.slice(2));
    if (key.startsWith("c:")) return this.codes.get(key.slice(2));
    if (key.startsWith("a:")) return this.accounts.get(key.slice(2));
    return undefined;
  }

  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._flushing) {
      if (!await this._flushing) return false;
      return this.flush();
    }
    const keys = [...this._dirty];
    this._dirty.clear();
    if (!keys.length) return true;
    this._flushing = (async () => {
      try {
        if (this._db) {
          for (const k of keys) {
            const v = this._value(k);
            if (v === undefined) await this._db.query("DELETE FROM ipet_kv WHERE k = ?", [k]);
            else await this._db.query("REPLACE INTO ipet_kv (k, v) VALUES (?, ?)", [k, JSON.stringify(v)]);
          }
        } else {
          const all = { meta: this.meta };
          for (const [pid, p] of this.players) all["p:" + pid] = p;
          for (const [id, k] of this.packs) all["k:" + id] = k;
          for (const [code, v] of this.codes) all["c:" + code] = v;
          for (const [key, v] of this.accounts) all["a:" + key] = v;
          fs.mkdirSync(path.dirname(this._file), { recursive: true });
          const tmp = this._file + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify(all));
          fs.renameSync(tmp, this._file);
        }
        return true;
      } catch (e) {
        this.log("store: save failed, will retry:", e.message);
        for (const k of keys) this._dirty.add(k);
        if (!this._timer) this._timer = setTimeout(() => this.flush(), SAVE_DELAY_MS * 3);
        return false;
      }
    })();
    const result = await this._flushing;
    this._flushing = null;
    if (result && this._dirty.size) return this.flush();
    return result;
  }
}

module.exports = { Store };
