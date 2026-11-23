"use strict";
// Live game settings (Nigel's hidden admin panel → Game Settings).
//
// Only the values Nigel changed are kept, in store.meta.cfg. Games download them
// with GET /config when they start, get them in "welcome" when they connect, and
// get a "cfg" message the moment Nigel saves. The same keys and limits are in
// scripts/game_config.gd in the game: change both together.

const KEYS = {
  "claw.on": [0, 1, "int"], "claw.cost": [0, 100, "int"], "claw.tries": [0, 20, "int"], "claw.win": [0, 100, "num"],
  "arcade.on": [0, 1, "int"], "arcade.cost": [0, 100, "int"], "arcade.tries": [0, 20, "int"],
  "arcade.prize_min": [0, 1000, "int"], "arcade.prize_max": [0, 1000, "int"],
  "slots.on": [0, 1, "int"], "slots.cost": [0, 100, "int"], "slots.pulls": [0, 50, "int"],
  "slots.win": [0, 50, "num"], "slots.jackpot_chance": [0, 10, "num"],
  "slots.p_bone": [0, 10000, "int"], "slots.p_fish": [0, 10000, "int"], "slots.p_bell": [0, 10000, "int"],
  "slots.p_star": [0, 10000, "int"], "slots.p_seven": [0, 10000, "int"], "slots.jackpot": [0, 10000, "int"],
  "vend.on": [0, 1, "int"], "vend.price": [0, 10000, "int"], "vend.protect": [0, 30, "num"], "vend.head_start": [0, 10, "num"],
  "bolts.multiplier": [1, 5, "int"], "bolts.played": [0, 1000, "int"], "bolts.won": [0, 1000, "int"],
  "bolts.finale": [0, 1000, "int"], "bolts.challenge": [0, 1000, "int"],
  "tokens.value": [1, 100, "int"], "tokens.cap": [0, 1000, "int"], "tokens.cap_free": [0, 2000, "int"],
};

// Text settings: key -> check. The How to Play video must be a YouTube link.
const VIDEO_RE = /^https:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[A-Za-z0-9_-]{6,20}([?&][A-Za-z0-9_=&%.-]*)?$/;
const TEXTS = { "video.url": (v) => typeof v === "string" && v.length <= 120 && VIDEO_RE.test(v) };

function createConfig({ store, clients, send, error, log }) {
  function current() {
    return store.meta.cfg || {};
  }

  function updated() {
    return store.meta.cfgUpdated || "";
  }

  // Merges a change: known keys only, clamped to their limits; null puts a key back to its default.
  function merge(values) {
    const out = Object.assign({}, current());
    if (!values || typeof values !== "object") return out;
    for (const [k, v] of Object.entries(values)) {
      if (TEXTS[k]) {
        if (v === null) delete out[k];
        else if (TEXTS[k](v)) out[k] = v;
        continue;
      }
      const spec = KEYS[k];
      if (!spec) continue;
      if (v === null) {
        delete out[k];
        continue;
      }
      let x = Number(v);
      if (!Number.isFinite(x)) continue;
      x = Math.max(spec[0], Math.min(spec[1], x));
      out[k] = spec[2] === "int" ? Math.round(x) : Math.round(x * 100) / 100;
    }
    return out;
  }

  const handlers = {
    admin_cfg(c, m) {
      if (!c.admin) return error(c, "admin", "Not allowed.");
      store.meta.cfg = merge(m.values);
      store.meta.cfgUpdated = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
      store.touchMeta();
      log(`admin ${c.tag} saved game settings (${Object.keys(store.meta.cfg).length} changed)`);
      const msg = { t: "cfg", values: current(), updated: updated() };
      for (const other of clients.values()) if (other.hello) send(other, msg);
    },
  };

  return { handlers, current, updated };
}

module.exports = { createConfig, KEYS, TEXTS };
