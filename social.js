"use strict";
// Paw Points, ranks, the "Pet of the Week" leaderboards and Packs (clans).
//
// Players are recognised by a secret key their game makes once and keeps (it
// doubles as their recovery code). The server only stores a hash of it.
//
// Paw Points come only from online matches. The host's game works out each
// player's points from the match stats; the server checks the match really
// ran (2+ players, at least a minute) and caps points per match and per day,
// so a tampered game can't flood the boards.

const crypto = require("crypto");

const PP_MATCH_CAP = 150;     // most Paw Points one match can give a player
const PP_DAY_CAP = 1500;      // most a player can earn in one day
const MIN_MATCH_MS = parseInt(process.env.IPET_MIN_MATCH_MS || "60000", 10);   // tests can shorten it
const PACK_MAX = 20;
const PACK_CHAT_KEEP = 40;
const PACK_REWARD_BOLTS = 60;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Season ranks (by Paw Points this season). Index is sent to games.
const RANKS = [
  { name: "Bargain Bin", at: 0 },
  { name: "Clearance Rack", at: 100 },
  { name: "Shelf Pet", at: 300 },
  { name: "Display Window", at: 700 },
  { name: "Premium Pod", at: 1500 },
  { name: "Golden Collar", at: 3000 },
];

// The weekly Pack Heist: one shared goal per week, sized to the Pack.
const GOALS = [
  { type: "rescues", label: "Rescue %d pets", per: 6 },
  { type: "catches", label: "Catch %d pets as a Catcher", per: 6 },
  { type: "survivals", label: "Survive %d matches without being caught", per: 4 },
  { type: "pp", label: "Earn %d Paw Points together", per: 150 },
];

const DAY_MS = 86400000;
function dayId(t = Date.now()) { return Math.floor(t / DAY_MS); }
// Weeks start on Monday 00:00 UTC (1 Jan 1970 was a Thursday).
function weekId(t = Date.now()) { return Math.floor((dayId(t) + 3) / 7); }
function weekEndsAt(t = Date.now()) { return ((weekId(t) + 1) * 7 - 3) * DAY_MS; }
function seasonId(t = Date.now()) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function seasonLabel(id) {
  const [y, m] = id.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) + " Stocktake";
}

function rankOf(pp) {
  let r = 0;
  for (let i = 0; i < RANKS.length; i++) if (pp >= RANKS[i].at) r = i;
  return r;
}

function int(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return Math.max(lo, Math.min(hi, n));
}

function createSocial({ store, clients, send, error, log, cleanText, cleanTag }) {
  // ------------------------------------------------------------ periods --
  function rollover() {
    const w = weekId();
    if (store.meta.week === w) return;
    if (store.meta.week !== null && store.meta.week !== undefined) {
      const last = store.meta.week;
      let best = null;
      for (const p of store.players.values()) {
        if (p.week && p.week.id === last && p.week.pp > 0 && (!best || p.week.pp > best.week.pp)) best = p;
      }
      store.meta.champion = best ? { tag: best.tag, species: best.species, hat: best.hat || "", pp: best.week.pp, week: last } : null;
      store.meta.lastWeekPacks = [...store.packs.values()]
        .filter((k) => k.week && k.week.id === last && k.week.pp > 0)
        .sort((a, b) => b.week.pp - a.week.pp).slice(0, 3)
        .map((k) => ({ tag: k.tag, name: k.name, colour: k.colour, pp: k.week.pp }));
      if (best) log(`Pet of the Week: ${best.tag} (${best.week.pp} PP)`);
    }
    store.meta.week = w;
    store.meta.season = seasonId();
    store.touchMeta();
  }

  function week(p) {
    const w = weekId();
    if (!p.week || p.week.id !== w) p.week = { id: w, pp: 0, hider: 0, catcher: 0 };
    return p.week;
  }
  function season(p) {
    const s = seasonId();
    if (!p.season || p.season.id !== s) p.season = { id: s, pp: 0 };
    return p.season;
  }
  function today(p) {
    const d = dayId();
    if (!p.day || p.day.id !== d) p.day = { id: d, pp: 0 };
    return p.day;
  }
  function packWeek(k) {
    const w = weekId();
    if (!k.week || k.week.id !== w) {
      const g = GOALS[w % GOALS.length];
      k.week = { id: w, pp: 0, goal: g.type, target: g.per * Math.max(3, k.members.length), progress: 0, claimed: [], turf: {} };
    }
    return k.week;
  }

  // ---------------------------------------------------------- players --
  function identify(c, key) {
    rollover();
    if (typeof key !== "string" || key.length < 16 || key.length > 80) return null;
    const pid = crypto.createHash("sha256").update("ipet:" + key).digest("hex").slice(0, 24);
    let p = store.players.get(pid);
    if (!p) {
      p = { pid, created: Date.now(), total: 0, matches: 0, pack: null };
      store.players.set(pid, p);
    }
    p.tag = c.tag;
    p.species = c.species;
    p.hat = c.hat || "";
    p.seen = Date.now();
    c.pid = pid;
    store.touchPlayer(p);
    return p;
  }

  function playerOf(c) {
    return c && c.pid ? store.players.get(c.pid) : null;
  }

  function packOf(p) {
    return p && p.pack ? store.packs.get(p.pack) || null : null;
  }

  function profile(c) {
    const p = playerOf(c);
    if (!p) return null;
    const s = season(p).pp;
    const r = rankOf(s);
    const k = packOf(p);
    return {
      week_pp: week(p).pp, season_pp: s, total: p.total, matches: p.matches,
      rank: r, rank_name: RANKS[r].name, next_at: r + 1 < RANKS.length ? RANKS[r + 1].at : null,
      pack: k ? { id: k.id, tag: k.tag, name: k.name, colour: k.colour, emblem: k.emblem } : null,
      champion: store.meta.champion,
    };
  }

  // Extra bits other players see next to your name (lobby, match labels).
  function badge(c) {
    const p = playerOf(c);
    if (!p) return { rank: -1 };
    const k = packOf(p);
    return { rank: rankOf(season(p).pp), ptag: k ? k.tag : "", pcol: k ? k.colour : 0 };
  }

  // ---------------------------------------------------------- matches --
  // The host's end-of-match report. `players` = the room's clients at the start.
  function awardMatch(room, result, players) {
    rollover();
    const ran = Date.now() - (room.startedAt || Date.now());
    const humans = players.filter((c) => c && c.pid);
    if (ran < MIN_MATCH_MS || players.length < 2) {
      for (const c of humans) send(c, { t: "pp", gained: 0, why: "short", ...profile(c) });
      return;
    }
    // Special items on: a fun match, but it doesn't count for Paw Points or Packs.
    if (room.settings.specials) {
      for (const c of humans) send(c, { t: "pp", gained: 0, why: "specials", ...profile(c) });
      return;
    }
    const level = String(room.settings.level || "");
    const rows = (result && typeof result.pp === "object" && result.pp) || {};
    for (const c of humans) {
      const p = playerOf(c);
      const row = rows[String(c.id)] || {};
      const before = rankOf(season(p).pp);
      const day = today(p);
      let gained = int(row.pp, 0, PP_MATCH_CAP);
      gained = Math.min(gained, Math.max(0, PP_DAY_CAP - day.pp));
      const role = row.role === "catcher" ? "catcher" : "hider";
      day.pp += gained;
      const w = week(p);
      w.pp += gained;
      w[role] += gained;
      season(p).pp += gained;
      p.total += gained;
      p.matches += 1;
      p.species = c.species;
      store.touchPlayer(p);
      const k = packOf(p);
      if (k) {
        const kw = packWeek(k);
        kw.pp += gained;
        kw.turf[level] = (kw.turf[level] || 0) + gained;
        const add = { rescues: int(row.rescues, 0, 20), catches: int(row.catches, 0, 20),
          survivals: row.survived ? 1 : 0, pp: gained }[kw.goal] || 0;
        kw.progress = Math.min(kw.target, kw.progress + add);
        store.touchPack(k);
      }
      const after = rankOf(season(p).pp);
      send(c, { t: "pp", gained, capped: (Number(row.pp) || 0) > gained, rank_up: after > before, ...profile(c) });
    }
    // Pack mates who weren't in the match still see their goal move.
    const touched = new Set(humans.map((c) => (playerOf(c) || {}).pack).filter(Boolean));
    for (const id of touched) pushPack(store.packs.get(id));
  }

  // ------------------------------------------------------- leaderboards --
  function boardRows(tab) {
    const w = weekId();
    const s = seasonId();
    if (tab === "packs") {
      return [...store.packs.values()]
        .map((k) => ({ k, pp: k.week && k.week.id === w ? k.week.pp : 0 }))
        .filter((x) => x.pp > 0)
        .sort((a, b) => b.pp - a.pp)
        .map((x) => ({ id: x.k.id, tag: x.k.tag, name: x.k.name, colour: x.k.colour, emblem: x.k.emblem, members: x.k.members.length, pp: x.pp }));
    }
    const value = (p) => {
      if (tab === "season") return p.season && p.season.id === s ? p.season.pp : 0;
      if (!p.week || p.week.id !== w) return 0;
      return tab === "hiders" ? p.week.hider : tab === "catchers" ? p.week.catcher : p.week.pp;
    };
    return [...store.players.values()]
      .map((p) => ({ p, pp: value(p) }))
      .filter((x) => x.pp > 0)
      .sort((a, b) => b.pp - a.pp || (a.p.seen || 0) - (b.p.seen || 0))
      .map((x) => {
        const k = packOf(x.p);
        return { id: x.p.pid, tag: x.p.tag, species: x.p.species || 0, pp: x.pp,
          rank: rankOf(x.p.season && x.p.season.id === s ? x.p.season.pp : 0), ptag: k ? k.tag : "", pcol: k ? k.colour : 0 };
      });
  }

  function turf() {
    const w = weekId();
    const best = {};
    for (const k of store.packs.values()) {
      if (!k.week || k.week.id !== w) continue;
      for (const [level, pp] of Object.entries(k.week.turf || {})) {
        if (pp > 0 && (!best[level] || pp > best[level].pp)) best[level] = { tag: k.tag, name: k.name, colour: k.colour, pp };
      }
    }
    return best;
  }

  function board(c, m) {
    rollover();
    const tab = ["week", "season", "hiders", "catchers", "packs"].includes(m.tab) ? m.tab : "week";
    const rows = boardRows(tab);
    rows.forEach((r, i) => (r.place = i + 1));
    const p = playerOf(c);
    const mine = tab === "packs" ? (p && p.pack) : (p && p.pid);
    const at = mine ? rows.findIndex((r) => r.id === mine) : -1;
    const around = at >= 10 ? rows.slice(Math.max(10, at - 2), at + 3) : [];
    const strip = (r) => { const { id, ...rest } = r; return { ...rest, me: r.id === mine }; };
    send(c, {
      t: "board", tab, total: rows.length, top: rows.slice(0, 10).map(strip), around: around.map(strip),
      me: at >= 0 ? at + 1 : 0, champion: store.meta.champion, last_packs: store.meta.lastWeekPacks || [],
      turf: turf(), season: seasonLabel(seasonId()), week_ends_in: Math.round((weekEndsAt() - Date.now()) / 1000),
      profile: profile(c),
    });
  }

  // -------------------------------------------------------------- packs --
  function newPackCode() {
    const taken = new Set([...store.packs.values()].map((k) => k.code));
    for (let i = 0; i < 1000; i++) {
      let code = "";
      for (let j = 0; j < 6; j++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
      if (!taken.has(code)) return code;
    }
    return null;
  }

  function onlineByPid() {
    const map = new Map();
    for (const c of clients.values()) if (c.pid) map.set(c.pid, c);
    return map;
  }

  function packView(k, viewer) {
    const kw = packWeek(k);
    const online = onlineByPid();
    const g = GOALS.find((x) => x.type === kw.goal) || GOALS[0];
    const owned = Object.entries(turf()).filter(([, o]) => o.tag === k.tag).map(([level]) => level);
    return {
      t: "pack", id: k.id, name: k.name, tag: k.tag, colour: k.colour, emblem: k.emblem, code: k.code,
      leader: k.leader === (viewer && viewer.pid), max: PACK_MAX,
      members: k.members.map((pid) => {
        const p = store.players.get(pid) || { tag: "?" };
        return { pid, tag: p.tag, species: p.species || 0, week_pp: p.week && p.week.id === weekId() ? p.week.pp : 0,
          rank: rankOf(p.season && p.season.id === seasonId() ? p.season.pp : 0), leader: pid === k.leader, online: online.has(pid) };
      }).sort((a, b) => b.week_pp - a.week_pp),
      goal: { label: g.label.replace("%d", kw.target), type: kw.goal, progress: kw.progress, target: kw.target,
        done: kw.progress >= kw.target, claimed: !!viewer && kw.claimed.includes(viewer.pid), reward: PACK_REWARD_BOLTS },
      week_pp: kw.pp, turf: owned, chat: (k.chat || []).slice(-PACK_CHAT_KEEP),
    };
  }

  function pushPack(k) {
    if (!k) return;
    const online = onlineByPid();
    for (const pid of k.members) {
      const c = online.get(pid);
      if (c) send(c, packView(k, playerOf(c)));
    }
  }

  function needPlayer(c) {
    const p = playerOf(c);
    if (!p) error(c, "no_id", "Please update the game to use Paw Points and Packs.");
    return p;
  }

  function leavePack(p) {
    const k = packOf(p);
    p.pack = null;
    store.touchPlayer(p);
    if (!k) return;
    k.members = k.members.filter((x) => x !== p.pid);
    if (k.members.length === 0) {
      store.dropPack(k.id);
      log(`pack [${k.tag}] closed`);
      return;
    }
    if (k.leader === p.pid) k.leader = k.members[0];
    store.touchPack(k);
    pushPack(k);
  }

  const handlers = {
    me(c) {
      const pr = profile(c);
      send(c, { t: "me", profile: pr });
    },

    board,

    pack_create(c, m) {
      const p = needPlayer(c);
      if (!p) return;
      if (packOf(p)) return error(c, "in_pack", "Leave your Pack first.");
      const name = cleanText(String(m.name || "").trim().slice(0, 20));
      const tag = String(cleanTag(m.tag) || "").toUpperCase();
      if (!name || name.length < 3 || name.includes("*")) return error(c, "pack_name", "Pick a friendly Pack name of 3–20 letters.");
      if (!/^[A-Z0-9]{3,4}$/.test(tag)) return error(c, "pack_tag", "The Pack tag is 3 or 4 letters or numbers.");
      for (const k of store.packs.values()) {
        if (k.tag === tag) return error(c, "pack_taken", `[${tag}] is taken. Try another tag.`);
        if (k.name.toLowerCase() === name.toLowerCase()) return error(c, "pack_taken", "That Pack name is taken.");
      }
      const code = newPackCode();
      if (!code) return error(c, "busy", "Try again in a moment.");
      const id = crypto.randomBytes(6).toString("hex");
      const k = { id, name, tag, colour: int(m.colour, 0, 7), emblem: int(m.emblem, 0, 7), code, leader: p.pid,
        members: [p.pid], created: Date.now(), chat: [] };
      packWeek(k);
      store.packs.set(id, k);
      p.pack = id;
      store.touchPack(k);
      store.touchPlayer(p);
      log(`pack [${tag}] ${name} made by ${c.tag}`);
      send(c, packView(k, p));
    },

    pack_join(c, m) {
      const p = needPlayer(c);
      if (!p) return;
      const code = String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const k = [...store.packs.values()].find((x) => x.code === code);
      if (!k) return error(c, "no_pack", "No Pack with that code. Check it with your friend.");
      if (k.members.includes(p.pid)) return send(c, packView(k, p));
      if (k.members.length >= PACK_MAX) return error(c, "pack_full", "That Pack is full.");
      if (packOf(p)) leavePack(p);
      k.members.push(p.pid);
      p.pack = k.id;
      packWeek(k);
      store.touchPack(k);
      store.touchPlayer(p);
      packSay(k, `${c.tag} joined the Pack!`, true);
      pushPack(k);
    },

    pack_leave(c) {
      const p = needPlayer(c);
      if (!p) return;
      const k = packOf(p);
      if (k) packSay(k, `${c.tag} left the Pack.`, true);
      leavePack(p);
      send(c, { t: "pack", id: null });
    },

    pack_kick(c, m) {
      const p = needPlayer(c);
      const k = packOf(p);
      if (!k || k.leader !== p.pid || m.pid === p.pid) return;
      const target = store.players.get(String(m.pid));
      if (!target || target.pack !== k.id) return;
      leavePack(target);
      packSay(k, `${target.tag} was removed from the Pack.`, true);
      const tc = onlineByPid().get(target.pid);
      if (tc) send(tc, { t: "pack", id: null, kicked: true });
      pushPack(k);
    },

    pack_info(c) {
      const p = needPlayer(c);
      if (!p) return;
      const k = packOf(p);
      send(c, k ? packView(k, p) : { t: "pack", id: null });
    },

    pack_chat(c, m) {
      const p = needPlayer(c);
      const k = packOf(p);
      if (!k) return;
      const now = Date.now();
      if (now - (c.packChatAt || 0) < 1000) return error(c, "slow", "Slow down a little.");
      c.packChatAt = now;
      const text = cleanText(String(m.text || "").slice(0, 80));
      if (!text) return;
      packSay(k, text, false, c.tag);
    },

    pack_claim(c) {
      const p = needPlayer(c);
      const k = packOf(p);
      if (!k) return;
      const kw = packWeek(k);
      if (kw.progress < kw.target || kw.claimed.includes(p.pid)) return;
      kw.claimed.push(p.pid);
      store.touchPack(k);
      send(c, { t: "pack_reward", bolts: PACK_REWARD_BOLTS });
      send(c, packView(k, p));
    },
  };

  function packSay(k, text, system, from = "") {
    k.chat = k.chat || [];
    const msg = { tag: from, text, system, at: Date.now() };
    k.chat.push(msg);
    if (k.chat.length > PACK_CHAT_KEEP) k.chat.shift();
    store.touchPack(k);
    const online = onlineByPid();
    for (const pid of k.members) {
      const mc = online.get(pid);
      if (mc) send(mc, { t: "pack_chat", ...msg });
    }
  }

  // Rooms only your Pack can join.
  function packRoomFor(c) {
    const p = playerOf(c);
    return p && p.pack ? p.pack : null;
  }
  function canJoinPackRoom(c, room) {
    if (!room.pack) return true;
    const p = playerOf(c);
    return !!p && p.pack === room.pack;
  }
  function packTagOf(id) {
    const k = store.packs.get(id);
    return k ? k.tag : "";
  }

  setInterval(rollover, 60 * 1000);
  rollover();

  return { identify, profile, badge, awardMatch, handlers, turf, packRoomFor, canJoinPackRoom, packTagOf, RANKS };
}

module.exports = { createSocial, RANKS, weekId, seasonId };
