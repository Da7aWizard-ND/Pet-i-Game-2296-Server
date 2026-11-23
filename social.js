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
const PACK_MAX = 20;            // default size for packs made before sizes could be chosen
const PACK_SIZE_MIN = 6;
const PACK_SIZE_MAX = 40;
const PACK_COLOURS = 24;
const PACK_SHAPES = 24;
const PACK_SPECIES = 16;
const MAX_OFFICERS = 3;
const REQUEST_DAYS = 7;
const GIFT_BOLTS_DAY = 100;      // most bolts one player can send a day
const GIFT_ITEMS_DAY = 1;        // most special items one player can send a day
const GIFT_MIN_DAYS = 3;         // days in the Pack before you can send or receive gifts
const FACTIONS = ["Neon Night Shift", "Chrome Couriers", "Circuit Strays", "Kibble Syndicate"];
const FACTION_WIN_BOLTS = 50;    // each member of last week's winning faction
const FACTION_SMALL_BONUS = 0.10; // smallest faction earns this much more Paw Points
const ITEM_ID_RE = /^[a-z]{2,12}$/;
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

function cleanCountry(v) {
  const s = String(v || "").toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : "";
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
      const fw = factionScores(last);
      const top = fw.reduce((a, b) => (b.pp > a.pp ? b : a), fw[0]);
      store.meta.factionWin = top && top.pp > 0 ? { faction: top.faction, week: last, pp: top.pp } : null;
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
      pack: k ? patchOf(k) : null,
      champion: store.meta.champion,
      faction_win: store.meta.factionWin || null,
      faction_reward: k && store.meta.factionWin && k.faction === store.meta.factionWin.faction
        && p.factionClaim !== store.meta.factionWin.week ? FACTION_WIN_BOLTS : 0,
      inbox: (p.inbox || []).length,
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
      const myPack = packOf(p);
      if (myPack && myPack.faction === smallestFaction()) gained = Math.round(gained * (1 + FACTION_SMALL_BONUS));
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
        .map((x) => ({ id: x.k.id, ...patchOf(x.k), members: x.k.members.length, pp: x.pp }));
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
      factions: factionScores(weekId()), faction_win: store.meta.factionWin || null, smallest_faction: smallestFaction(),
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
      t: "pack", id: k.id, ...patchOf(k), code: k.code,
      leader: k.leader === (viewer && viewer.pid), officer: !!viewer && (k.officers || []).includes(viewer.pid),
      max: k.max || PACK_MAX, size_min: PACK_SIZE_MIN, size_max: PACK_SIZE_MAX,
      faction_locked: k.factionSeason === seasonId() && !!k.factionSet,
      factions: factionScores(weekId()), smallest_faction: smallestFaction(),
      requests: canApprove(k, viewer) ? pruneRequests(k).map((r) => ({ pid: r.pid, tag: r.tag, species: r.species,
        days_left: Math.max(1, Math.ceil((r.at + REQUEST_DAYS * DAY_MS - Date.now()) / DAY_MS)) })) : [],
      gift: viewer ? giftLeft(viewer, k) : null,
      members: k.members.map((pid) => {
        const p = store.players.get(pid) || { tag: "?" };
        return { pid, tag: p.tag, species: p.species || 0, week_pp: p.week && p.week.id === weekId() ? p.week.pp : 0,
          rank: rankOf(p.season && p.season.id === seasonId() ? p.season.pp : 0), leader: pid === k.leader,
          officer: (k.officers || []).includes(pid), online: online.has(pid),
          can_gift: memberDays(k, pid) >= GIFT_MIN_DAYS };
      }).sort((a, b) => (b.leader - a.leader) || (b.officer - a.officer) || (b.week_pp - a.week_pp)),
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
    k.officers = (k.officers || []).filter((x) => x !== p.pid);
    if (k.joined) delete k.joined[p.pid];
    if (k.leader === p.pid) {
      const byAge = [...k.members].sort((a, b) => ((k.joined || {})[a] || 0) - ((k.joined || {})[b] || 0));
      k.leader = k.officers.length ? k.officers[0] : byAge[0];
      k.officers = k.officers.filter((x) => x !== k.leader);
      const nl = store.players.get(k.leader);
      packSay(k, `${nl ? nl.tag : "Someone"} is the new Pack leader.`, true);
    }
    store.touchPack(k);
    pushPack(k);
  }

  // ------------------------------------------------- patches & factions --
  function patchOf(k) {
    return { tag: k.tag, name: k.name, colour: k.colour || 0, emblem: k.emblem || 0, mascot: k.mascot || 0,
      country: k.country || "", faction: Number.isInteger(k.faction) ? k.faction : 0 };
  }
  function factionScores(w) {
    const out = FACTIONS.map((name, i) => ({ faction: i, name, pp: 0, packs: 0, members: 0 }));
    for (const k of store.packs.values()) {
      const f = out[Number.isInteger(k.faction) ? k.faction : 0];
      if (!f) continue;
      f.packs += 1;
      f.members += k.members.length;
      if (k.week && k.week.id === w) f.pp += k.week.pp;
    }
    return out;
  }
  function smallestFaction() {
    const sc = factionScores(weekId());
    return sc.reduce((a, b) => (b.members < a.members ? b : a), sc[0]).faction;
  }
  function canApprove(k, p) {
    return !!p && (k.leader === p.pid || (k.officers || []).includes(p.pid));
  }
  function pruneRequests(k) {
    const now = Date.now();
    const before = (k.requests || []).length;
    k.requests = (k.requests || []).filter((r) => now - r.at < REQUEST_DAYS * DAY_MS);
    if (k.requests.length !== before) store.touchPack(k);
    return k.requests;
  }
  function memberDays(k, pid) {
    const t = (k.joined || {})[pid] || k.created || Date.now();
    return Math.floor((Date.now() - t) / DAY_MS);
  }
  function gifts(p) {
    const d = dayId();
    if (!p.gifts || p.gifts.day !== d) p.gifts = { day: d, bolts: 0, items: 0 };
    return p.gifts;
  }
  function giftLeft(p, k) {
    const g = gifts(p);
    return { bolts: Math.max(0, GIFT_BOLTS_DAY - g.bolts), items: Math.max(0, GIFT_ITEMS_DAY - g.items),
      ready: memberDays(k, p.pid) >= GIFT_MIN_DAYS, min_days: GIFT_MIN_DAYS };
  }
  function addMember(k, p) {
    k.members.push(p.pid);
    k.joined = k.joined || {};
    k.joined[p.pid] = Date.now();
    p.pack = k.id;
    k.requests = (k.requests || []).filter((r) => r.pid !== p.pid);
    packWeek(k);
    store.touchPack(k);
    store.touchPlayer(p);
  }
  function deliverInbox(c) {
    const p = playerOf(c);
    if (!p || !(p.inbox || []).length) return;
    for (const g of p.inbox) send(c, { t: "gift", ...g });
    p.inbox = [];
    store.touchPlayer(p);
  }

  const handlers = {
    me(c) {
      deliverInbox(c);
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
      const k = { id, name, tag, colour: int(m.colour, 0, PACK_COLOURS - 1), emblem: int(m.emblem, 0, PACK_SHAPES - 1),
        mascot: int(m.mascot, 0, PACK_SPECIES - 1), country: cleanCountry(m.country), faction: int(m.faction, 0, FACTIONS.length - 1),
        factionSeason: seasonId(), factionSet: true, max: int(m.max, PACK_SIZE_MIN, PACK_SIZE_MAX) || PACK_MAX,
        code, leader: p.pid, officers: [], requests: [], joined: { [p.pid]: Date.now() },
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
      if (k.members.length >= (k.max || PACK_MAX)) return error(c, "pack_full", "That Pack is full.");
      pruneRequests(k);
      if (!k.requests.some((r) => r.pid === p.pid)) {
        if (k.requests.length >= 50) return error(c, "pack_busy", "That Pack has too many requests waiting. Try again later.");
        k.requests.push({ pid: p.pid, tag: c.tag, species: c.species || 0, at: Date.now() });
        store.touchPack(k);
      }
      send(c, { t: "pack_requested", tag: k.tag, name: k.name, days: REQUEST_DAYS });
      pushPack(k);      // the leader and officers see the request
    },

    // Leader or officer: let a requester in (ok) or turn them down.
    pack_approve(c, m) {
      const p = needPlayer(c);
      const k = packOf(p);
      if (!k || !canApprove(k, p)) return;
      const pid = String(m.pid || "");
      const req = pruneRequests(k).find((r) => r.pid === pid);
      if (!req) return send(c, packView(k, p));
      const target = store.players.get(pid);
      k.requests = k.requests.filter((r) => r.pid !== pid);
      store.touchPack(k);
      const tc = onlineByPid().get(pid);
      if (!m.ok || !target) {
        if (tc) send(tc, { t: "pack_declined", tag: k.tag, name: k.name });
        return pushPack(k);
      }
      if (k.members.length >= (k.max || PACK_MAX)) return error(c, "pack_full", "Your Pack is full. Make it bigger first.");
      if (packOf(target)) leavePack(target);
      addMember(k, target);
      packSay(k, `${target.tag} joined the Pack!`, true);
      if (tc) send(tc, packView(k, target));
      pushPack(k);
    },

    // Leader: name or remove an officer (up to 3; they can approve requests).
    pack_officer(c, m) {
      const p = needPlayer(c);
      const k = packOf(p);
      const pid = String(m.pid || "");
      if (!k || k.leader !== p.pid || pid === p.pid || !k.members.includes(pid)) return;
      k.officers = (k.officers || []).filter((x) => x !== pid);
      if (m.on) {
        if (k.officers.length >= MAX_OFFICERS) return error(c, "officers", `A Pack can have ${MAX_OFFICERS} officers.`);
        k.officers.push(pid);
      }
      store.touchPack(k);
      const t = store.players.get(pid);
      packSay(k, `${t ? t.tag : "?"} is ${m.on ? "now an officer" : "no longer an officer"}.`, true);
      pushPack(k);
    },

    // Leader: patch (colour, shape, mascot, country), Pack size, faction (once a season).
    pack_edit(c, m) {
      const p = needPlayer(c);
      const k = packOf(p);
      if (!k || k.leader !== p.pid) return;
      if (m.colour !== undefined) k.colour = int(m.colour, 0, PACK_COLOURS - 1);
      if (m.emblem !== undefined) k.emblem = int(m.emblem, 0, PACK_SHAPES - 1);
      if (m.mascot !== undefined) k.mascot = int(m.mascot, 0, PACK_SPECIES - 1);
      if (m.country !== undefined) k.country = cleanCountry(m.country);
      if (m.max !== undefined) {
        const want = int(m.max, PACK_SIZE_MIN, PACK_SIZE_MAX);
        if (want < k.members.length) return error(c, "pack_size", `Your Pack has ${k.members.length} members already.`);
        k.max = want;
      }
      if (m.faction !== undefined) {
        const f = int(m.faction, 0, FACTIONS.length - 1);
        if (f !== k.faction) {
          if (k.factionSet && k.factionSeason === seasonId())
            return error(c, "faction_locked", "Your Pack can switch faction when the next season starts.");
          k.faction = f;
          k.factionSeason = seasonId();
          k.factionSet = true;
          packSay(k, `The Pack joined the ${FACTIONS[f]}!`, true);
        }
      }
      store.touchPack(k);
      pushPack(k);
    },

    // Send bolts and/or one special item to a Pack mate. The sender's game takes
    // them out of its own save when it gets "gift_sent" back.
    pack_gift(c, m) {
      const p = needPlayer(c);
      const k = packOf(p);
      if (!k) return;
      const pid = String(m.pid || "");
      const target = store.players.get(pid);
      if (!target || target.pack !== k.id || pid === p.pid) return error(c, "gift", "They aren't in your Pack.");
      if (memberDays(k, p.pid) < GIFT_MIN_DAYS || memberDays(k, pid) < GIFT_MIN_DAYS)
        return error(c, "gift_new", `Gifts work once you've both been in the Pack for ${GIFT_MIN_DAYS} days.`);
      const g = gifts(p);
      const bolts = int(m.bolts, 0, GIFT_BOLTS_DAY);
      const item = typeof m.item === "string" && ITEM_ID_RE.test(m.item) ? m.item : "";
      if (bolts === 0 && !item) return;
      if (g.bolts + bolts > GIFT_BOLTS_DAY) return error(c, "gift_limit", `You can send ${GIFT_BOLTS_DAY - g.bolts} more bolts today.`);
      if (item && g.items + 1 > GIFT_ITEMS_DAY) return error(c, "gift_limit", "You've sent today's item already.");
      g.bolts += bolts;
      if (item) g.items += 1;
      store.touchPlayer(p);
      const gift = { from: c.tag, bolts, item, at: Date.now() };
      k.giftlog = (k.giftlog || []).concat([{ from: p.pid, to: pid, bolts, item, at: gift.at }]).slice(-100);
      log(`gift [${k.tag}] ${c.tag} -> ${target.tag}: ${bolts} bolts ${item}`);
      const tc = onlineByPid().get(pid);
      if (tc) send(tc, { t: "gift", ...gift });
      else {
        target.inbox = (target.inbox || []).concat([gift]).slice(-20);
        store.touchPlayer(target);
      }
      send(c, { t: "gift_sent", bolts, item, to: target.tag });
      const what = [bolts ? `${bolts} bolts` : "", item ? "a special item" : ""].filter(Boolean).join(" and ");
      packSay(k, `${c.tag} sent ${target.tag} ${what}`, true, "", true);
    },

    // Members of last week's winning faction collect their bonus once.
    faction_claim(c) {
      const p = needPlayer(c);
      const k = packOf(p);
      const fw = store.meta.factionWin;
      if (!k || !fw || k.faction !== fw.faction || p.factionClaim === fw.week) return;
      p.factionClaim = fw.week;
      store.touchPlayer(p);
      send(c, { t: "faction_reward", bolts: FACTION_WIN_BOLTS, faction: FACTIONS[fw.faction] });
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

  function packSay(k, text, system, from = "", gift = false) {
    k.chat = k.chat || [];
    const msg = { tag: from, text, system, gift, at: Date.now() };
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

  return { identify, playerOf, profile, badge, awardMatch, handlers, turf, packRoomFor, canJoinPackRoom, packTagOf, RANKS };
}

module.exports = { createSocial, RANKS, weekId, seasonId, FACTIONS };
