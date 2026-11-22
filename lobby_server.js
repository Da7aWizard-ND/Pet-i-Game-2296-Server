// i-Pet Cyber Store 2096 lobby + relay server.
//
// One small program that every player connects to over a WebSocket (works
// from browsers, phones and the PC build alike). It:
//   - gives each player a unique tag (Name#1234) and checks their game version,
//   - keeps rooms with a 4-letter code, up to MAX_PLAYERS humans each,
//   - lets the host change match settings and start when everyone is ready,
//   - runs the chat (filtered, rate-limited, quick-chat phrases, reports),
//   - lists public rooms for the "Browse games" screen,
//   - relays game messages between the host and the other players once a
//     match is running (the host's game runs the bots and decides catches).
//
// Run:   npm install   then   node lobby_server.js
// Port:  PORT environment variable (free hosts set this), default 8080.
// Health check: GET / returns "i-Pet Cyber Store 2096 lobby OK".

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { cleanText, cleanTag } = require("./filter");
const { Store } = require("./store");
const { createSocial } = require("./social");

const PROTOCOL = 1;              // bump when the message format changes (old games get "please update")
const PORT = parseInt(process.env.PORT || "8080", 10);
const MAX_PLAYERS = 8;           // humans per room (computer pets fill the rest)
const MAX_ROOMS = 200;
const MAX_CLIENTS = 1000;
const CHAT_MAX = 80;             // characters per message
const CHAT_HISTORY = 30;         // messages kept per room (new joiners see these; reports include them)
const RELAY_MAX_BYTES = 16 * 1024;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O (they look like 1 and 0)
const REPORT_FILE = path.join(__dirname, "reports.log");

// Quick-chat phrases. The game has the same list (net.gd QUICK_CHAT) and
// shows them as buttons; only the number travels over the wire.
const QUICK_CHAT_COUNT = 12;

// Match settings the host may change, with what's allowed.
const SETTING_RULES = {
  mode: (v) => ["classic", "tag", "infection", "heist", "alpha", "blackout", "freeze", "mole"].includes(v),
  level: (v) => ["megastore", "vet", "warehouse", "garden"].includes(v),
  difficulty: (v) => ["easy", "normal", "hard"].includes(v),
  bots: (v) => Number.isInteger(v) && v >= 0 && v <= 30,
  items_trip: (v) => Number.isInteger(v) && v >= 0 && v <= 5,
  items_adv: (v) => Number.isInteger(v) && v >= 0 && v <= 5,
  items_sab: (v) => Number.isInteger(v) && v >= 0 && v <= 5,
  public: (v) => typeof v === "boolean",
  duration: (v) => [60, 90, 120, 180, 240, 300, 420, 600].includes(v),   // seek-phase seconds (MatchSettings.DURATIONS)
  specials: (v) => typeof v === "boolean",   // special items, bolt tokens and machines (no Paw Points when on)
};
const DEFAULT_SETTINGS = { mode: "classic", level: "megastore", difficulty: "normal", bots: 4, items_trip: 1, items_adv: 1, items_sab: 1, public: false, duration: 180, specials: false };

let nextId = 1;
const clients = new Map();   // id -> client
const rooms = new Map();     // code -> room

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// Paw Points, leaderboards and Packs (see social.js); saved by store.js.
const store = new Store(log);
let social = null;

// ------------------------------------------------------------------ helpers --

function send(client, msg) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
}

function error(client, code, text) {
  send(client, { t: "error", code, text });
}

function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function publicPlayer(c) {
  return { id: c.id, tag: c.tag, species: c.species, ready: c.ready, ...(social ? social.badge(c) : {}) };
}

function roomState(room) {
  return {
    t: "room",
    code: room.code,
    host: room.host,
    started: room.started,
    max: MAX_PLAYERS,
    settings: room.settings,
    pack: room.pack ? social.packTagOf(room.pack) : "",
    players: room.players.map((id) => publicPlayer(clients.get(id))).filter(Boolean),
  };
}

function broadcast(room, msg, exceptId = 0) {
  for (const id of room.players) {
    if (id === exceptId) continue;
    const c = clients.get(id);
    if (c) send(c, msg);
  }
}

function pushRoom(room) {
  broadcast(room, roomState(room));
}

function systemChat(room, text) {
  const msg = { t: "chat", from: 0, tag: "", text, system: true, at: Date.now() };
  remember(room, msg);
  broadcast(room, msg);
}

function remember(room, msg) {
  room.history.push(msg);
  if (room.history.length > CHAT_HISTORY) room.history.shift();
}

// Tags are unique among everyone online: Name#1234. Players keep their
// number between visits (the game saves it); we only change it on a clash.
function uniqueTag(base, wanted) {
  const taken = new Set([...clients.values()].map((c) => c.tag));
  let num = Number.isInteger(wanted) && wanted >= 1000 && wanted <= 9999 ? wanted : 1000 + Math.floor(Math.random() * 9000);
  for (let tries = 0; tries < 50; tries++) {
    const tag = `${base}#${num}`;
    if (!taken.has(tag)) return tag;
    num = 1000 + Math.floor(Math.random() * 9000);
  }
  return `${base}#${Date.now() % 10000}`;
}

// ------------------------------------------------------------------- rooms --

function leaveRoom(client, why = "left") {
  const room = rooms.get(client.room);
  client.room = null;
  client.ready = false;
  if (!room) return;
  room.players = room.players.filter((id) => id !== client.id);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    log(`room ${room.code} closed`);
    return;
  }
  systemChat(room, `${client.tag} ${why === "dropped" ? "lost connection" : "left"}.`);
  if (room.host === client.id) {
    if (room.started) {
      // The host's game was running the match; it can't carry on without it.
      room.started = false;
      broadcast(room, { t: "match_over", reason: "host_left" });
      systemChat(room, "The host left, so the match ended.");
    }
    room.host = room.players[0];
    const h = clients.get(room.host);
    if (h) systemChat(room, `${h.tag} is the host now.`);
  } else if (room.started) {
    // Tell the host so a computer pet takes over this player's pet.
    const h = clients.get(room.host);
    if (h) send(h, { t: "peer_left", id: client.id });
  }
  for (const id of room.players) clients.get(id).ready = false;
  pushRoom(room);
}

function joinRoom(client, room) {
  if (room.players.length >= MAX_PLAYERS) return error(client, "full", "That game is full.");
  if (room.started) return error(client, "started", "That game has already started. Try again when it's back in the lobby.");
  if (room.banned.has(client.ip)) return error(client, "banned", "You can't join that game.");
  if (!social.canJoinPackRoom(client, room)) return error(client, "pack_only", "That game is only for its Pack's members.");
  if (client.room) leaveRoom(client);
  client.room = room.code;
  client.ready = false;
  room.players.push(client.id);
  send(client, { t: "joined", code: room.code });
  for (const m of room.history) send(client, m);
  systemChat(room, `${client.tag} joined.`);
  pushRoom(room);
}

// ---------------------------------------------------------------- messages --

const handlers = {
  hello(c, m) {
    if (m.protocol !== PROTOCOL) {
      return error(c, "version", "Your game is a different version from the server. Please update i-Pet Cyber Store 2096.");
    }
    const base = cleanTag(m.tag);
    if (!base) return error(c, "bad_tag", "Pick a tag of 3–14 letters or numbers (and keep it friendly).");
    if (c.tag) c.tag = null;  // re-hello: let them take a fresh unique tag
    c.tag = uniqueTag(base, m.num);
    c.species = Number.isInteger(m.species) ? m.species : 0;
    c.version = String(m.version || "").slice(0, 20);
    c.hat = typeof m.hat === "string" ? m.hat.replace(/[^a-z]/g, "").slice(0, 20) : "";
    c.hello = true;
    social.identify(c, m.key);
    send(c, { t: "welcome", id: c.id, tag: c.tag, protocol: PROTOCOL, max_players: MAX_PLAYERS, quick_count: QUICK_CHAT_COUNT,
      profile: social.profile(c) });
  },

  create(c, m) {
    if (rooms.size >= MAX_ROOMS) return error(c, "busy", "The server is busy right now. Try again in a minute.");
    const code = newCode();
    if (!code) return error(c, "busy", "Couldn't make a room code. Try again.");
    const room = { code, host: c.id, players: [], started: false, settings: { ...DEFAULT_SETTINGS }, history: [], banned: new Set(), created: Date.now() };
    applySettings(room, m.settings || {});
    if (m.settings && m.settings.pack_only) {
      room.pack = social.packRoomFor(c);
      if (!room.pack) return error(c, "no_pack", "Join a Pack first to make a Pack-only game.");
      room.settings.specials = false;   // Pack games always count for the Pack Heist
    }
    rooms.set(code, room);
    log(`room ${code} opened by ${c.tag}`);
    joinRoom(c, room);
  },

  join(c, m) {
    const code = String(m.code || "").toUpperCase().replace(/[^A-Z]/g, "");
    const room = rooms.get(code);
    if (!room) return error(c, "no_room", `No game with code ${code || "(blank)"}. Check the letters with your friend.`);
    joinRoom(c, room);
  },

  list(c) {
    const out = [];
    for (const r of rooms.values()) {
      if (r.started || r.players.length >= MAX_PLAYERS) continue;
      const mine = r.pack && social.canJoinPackRoom(c, r);
      if (!mine && (!r.settings.public || r.pack)) continue;
      const h = clients.get(r.host);
      out.push({ code: r.code, host: h ? h.tag : "?", players: r.players.length, max: MAX_PLAYERS, mode: r.settings.mode, level: r.settings.level,
        pack: r.pack ? social.packTagOf(r.pack) : "" });
      if (out.length >= 30) break;
    }
    send(c, { t: "list", rooms: out });
  },

  leave(c) {
    leaveRoom(c);
    send(c, { t: "left" });
  },

  pet(c, m) {
    if (!Number.isInteger(m.species)) return;
    c.species = m.species;
    const room = rooms.get(c.room);
    if (room) pushRoom(room);
  },

  ready(c, m) {
    const room = rooms.get(c.room);
    if (!room || room.started) return;
    c.ready = !!m.ready;
    pushRoom(room);
  },

  settings(c, m) {
    const room = rooms.get(c.room);
    if (!room || room.host !== c.id || room.started) return;
    applySettings(room, m.settings || {});
    if (room.pack) room.settings.specials = false;
    // Changing the match un-readies everyone so nobody starts something they didn't agree to.
    for (const id of room.players) if (id !== room.host) clients.get(id).ready = false;
    pushRoom(room);
  },

  start(c) {
    const room = rooms.get(c.room);
    if (!room || room.host !== c.id || room.started) return;
    if (room.players.length < 2) return error(c, "alone", "You need at least one other player to start an online game.");
    const waiting = room.players.map((id) => clients.get(id)).filter((p) => p.id !== room.host && !p.ready);
    if (waiting.length) return error(c, "not_ready", `Waiting for ${waiting.map((p) => p.tag).join(", ")} to press Ready.`);
    room.started = true;
    room.startedAt = Date.now();
    room.startPlayers = [...room.players];
    const seed = Math.floor(Math.random() * 2 ** 31);
    broadcast(room, { t: "started", seed, host: room.host, settings: room.settings, players: room.players.map((id) => publicPlayer(clients.get(id))),
      turf: social.turf()[room.settings.level] || null });
    systemChat(room, "The night shift begins!");
    pushRoom(room);
    log(`room ${room.code} started (${room.players.length} players, ${room.settings.mode}/${room.settings.level})`);
  },

  // The host says the match is over: everyone goes back to the room.
  end(c, m) {
    const room = rooms.get(c.room);
    if (!room || room.host !== c.id || !room.started) return;
    room.started = false;
    for (const id of room.players) clients.get(id).ready = false;
    broadcast(room, { t: "match_over", reason: "finished", result: m.result || null });
    const finishers = (room.startPlayers || []).map((id) => clients.get(id)).filter((p) => p && p.room === room.code);
    social.awardMatch(room, m.result, finishers);
    pushRoom(room);
  },

  chat(c, m) {
    const room = rooms.get(c.room);
    if (!room) return;
    const now = Date.now();
    c.chatTimes = c.chatTimes.filter((t) => now - t < 10000);
    if (c.chatTimes.length >= 5 || now - (c.chatTimes[c.chatTimes.length - 1] || 0) < 700) {
      return error(c, "slow", "Slow down a little.");
    }
    if (now < c.mutedUntil) return error(c, "muted", "Chat is paused for you for a moment.");
    c.chatTimes.push(now);
    const team = m.team === "hiders" || m.team === "catchers" ? m.team : "";
    let msg;
    if (Number.isInteger(m.quick) && m.quick >= 0 && m.quick < QUICK_CHAT_COUNT) {
      msg = { t: "chat", from: c.id, tag: c.tag, quick: m.quick, team, at: now };
    } else {
      const text = cleanText(String(m.text || "").slice(0, CHAT_MAX));
      if (!text) return;
      // Someone typing lots of starred-out words gets a short time-out.
      if ((text.match(/\*{3,}/g) || []).length >= 2) c.mutedUntil = now + 30000;
      msg = { t: "chat", from: c.id, tag: c.tag, text, team, at: now };
    }
    // Team chat during a match goes only to players the host says are on
    // that team (the host keeps the server's team list up to date).
    if (team && room.started && room.teams) {
      remember(room, msg);
      for (const id of room.players) {
        if (room.teams[id] === team || id === c.id) send(clients.get(id), msg);
      }
      return;
    }
    remember(room, msg);
    broadcast(room, msg);
  },

  // Host keeps the server told who is on which side (for team chat).
  teams(c, m) {
    const room = rooms.get(c.room);
    if (!room || room.host !== c.id) return;
    room.teams = {};
    for (const [id, team] of Object.entries(m.teams || {})) {
      if (team === "hiders" || team === "catchers") room.teams[Number(id)] = team;
    }
  },

  report(c, m) {
    const room = rooms.get(c.room);
    const target = clients.get(m.id);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      by: c.tag,
      against: target ? target.tag : m.id,
      room: room ? room.code : null,
      chat: room ? room.history.slice(-15) : [],
    });
    fs.appendFile(REPORT_FILE, line + "\n", () => {});
    send(c, { t: "reported" });
    log(`report by ${c.tag} against ${target ? target.tag : m.id}`);
  },

  // Host only: remove a player from the room (and keep them out of this room).
  kick(c, m) {
    const room = rooms.get(c.room);
    const target = clients.get(m.id);
    if (!room || room.host !== c.id || !target || target.room !== room.code || target.id === c.id) return;
    room.banned.add(target.ip);
    leaveRoom(target, "left");
    send(target, { t: "kicked" });
  },

  // Game traffic once a match runs. to = player id, or 0 = everyone else.
  relay(c, m, raw) {
    const room = rooms.get(c.room);
    if (!room || !room.started) return;
    if (raw.length > RELAY_MAX_BYTES) return;
    const out = JSON.stringify({ t: "relay", from: c.id, d: m.d });
    if (m.to) {
      const target = clients.get(m.to);
      if (target && target.room === room.code && target.ws.readyState === 1) target.ws.send(out);
      return;
    }
    for (const id of room.players) {
      if (id === c.id) continue;
      const p = clients.get(id);
      if (p && p.ws.readyState === 1) p.ws.send(out);
    }
  },

  ping(c, m) {
    send(c, { t: "pong", at: m.at });
  },
};

function applySettings(room, s) {
  for (const [k, v] of Object.entries(s)) {
    if (SETTING_RULES[k] && SETTING_RULES[k](v)) room.settings[k] = v;
  }
}

// ------------------------------------------------------------------ server --

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(`i-Pet Cyber Store 2096 lobby OK · ${clients.size} online · ${rooms.size} rooms · ${store.players.size} players · ${store.packs.size} packs (${store.kind})\n`);
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on("connection", (ws, req) => {
  if (clients.size >= MAX_CLIENTS) {
    ws.close(1013, "busy");
    return;
  }
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const c = { id: nextId++, ws, ip, tag: null, species: 0, ready: false, room: null, hello: false, chatTimes: [], mutedUntil: 0, alive: true, msgCount: 0, msgWindow: Date.now() };
  clients.set(c.id, c);

  ws.on("pong", () => (c.alive = true));
  ws.on("message", (data) => {
    // Flood guard: 120 messages a second is far more than the game sends.
    const now = Date.now();
    if (now - c.msgWindow > 1000) {
      c.msgWindow = now;
      c.msgCount = 0;
    }
    if (++c.msgCount > 120) return;
    const raw = data.toString();
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== "string" || !handlers[m.t]) return;
    if (!c.hello && m.t !== "hello" && m.t !== "ping") return error(c, "hello_first", "Say hello first.");
    try {
      handlers[m.t](c, m, raw);
    } catch (e) {
      log("handler error", m.t, e);
    }
  });
  ws.on("close", () => {
    if (c.room) leaveRoom(c, "dropped");
    clients.delete(c.id);
  });
  ws.on("error", () => {});
});

// Drop connections that stopped answering (closed laptops, lost signal).
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    try {
      c.ws.ping();
    } catch {}
  }
}, 20000);

async function main() {
  await store.open();
  social = createSocial({ store, clients, send, error, log, cleanText, cleanTag });
  Object.assign(handlers, social.handlers);
  server.listen(PORT, () => log(`i-Pet Cyber Store 2096 lobby listening on port ${PORT}`));
}

// Save before the host stops or restarts the server.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await store.flush();
    process.exit(0);
  });
}

main();
