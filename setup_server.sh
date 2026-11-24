#!/usr/bin/env bash
# i-Pet Cyber Store 2096 lobby server setup, for a fresh Ubuntu server (Oracle Cloud,
# Vultr, or any Ubuntu 22.04/24.04 box).
#
#   bash setup_server.sh <duckdns-name>
#
# e.g. "bash setup_server.sh ipet2096" for ipet2096.duckdns.org.
# It installs Node.js and Caddy, puts the lobby server and website in /opt/peti-lobby,
# keeps it running (and restarts it after a reboot or crash), opens ports
# 80/443, and gets a free security certificate so the game can connect with
# wss://<name>.duckdns.org (the web/phone version needs that).
#
# Safe to run again: that's also how you update the server to a new version
# (upload the new setup_server.sh and website files, then run it).
set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "Usage: bash setup_server.sh <duckdns-name>   (e.g. ipet2096)"
  exit 1
fi
DOMAIN="$NAME"
[[ "$DOMAIN" == *.* ]] || DOMAIN="$NAME.duckdns.org"
SUDO=""
[[ $EUID -ne 0 ]] && SUDO="sudo"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/website/index.html" && -d "$SCRIPT_DIR/website/img" ]]; then
  SITE_SOURCE="$SCRIPT_DIR/website"
  SITE_MODE="folder"
elif [[ -f "$SCRIPT_DIR/index.html" && -d "$SCRIPT_DIR/img" ]]; then
  SITE_SOURCE="$SCRIPT_DIR"
  SITE_MODE="flat"
else
  echo "Website files not found. Upload website/ or index.html and img/ beside setup_server.sh."
  exit 1
fi

echo "==> i-Pet lobby server for $DOMAIN"

echo "==> Installing Node.js and Caddy (a few minutes the first time)"
$SUDO apt-get update -y -q
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs npm caddy iptables-persistent netfilter-persistent >/dev/null || \
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs npm caddy >/dev/null
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if (( NODE_MAJOR < 18 )); then
  echo "!! Node.js $NODE_MAJOR is too old (need 18+). Use Ubuntu 24.04, or install Node 20 from nodesource.com."
  exit 1
fi

echo "==> Writing the lobby server to /opt/peti-lobby"
$SUDO mkdir -p /opt/peti-lobby
$SUDO tee /opt/peti-lobby/lobby_server.js >/dev/null <<'PETI_EOF'
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
// Website: GET / serves the i-Pet Cyber Store website.

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { cleanText, cleanTag } = require("./filter");

const PROTOCOL = 1;              // bump when the message format changes (old games get "please update")
const PORT = parseInt(process.env.PORT || "8080", 10);
const MAX_PLAYERS = 8;           // humans per room (computer pets fill the rest)
const MAX_ROOMS = 200;
const MAX_CLIENTS = 1000;
const CHAT_MAX = 80;             // characters per message
const CHAT_HISTORY = 30;         // messages kept per room (new joiners see these; reports include them)
const RELAY_MAX_BYTES = 16 * 1024;
const SITE_DIR = fs.existsSync(path.join(__dirname, "site"))
  ? path.join(__dirname, "site")
  : fs.existsSync(path.join(__dirname, "website"))
    ? path.join(__dirname, "website")
    : fs.existsSync(path.join(__dirname, "index.html"))
      ? __dirname
      : path.resolve(__dirname, "..", "website");
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
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
};
const DEFAULT_SETTINGS = { mode: "classic", level: "megastore", difficulty: "normal", bots: 4, items_trip: 1, items_adv: 1, items_sab: 1, public: false, duration: 180 };

let nextId = 1;
const clients = new Map();   // id -> client
const rooms = new Map();     // code -> room

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

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
  return { id: c.id, tag: c.tag, species: c.species, ready: c.ready };
}

function roomState(room) {
  return {
    t: "room",
    code: room.code,
    host: room.host,
    started: room.started,
    max: MAX_PLAYERS,
    settings: room.settings,
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
    c.hello = true;
    send(c, { t: "welcome", id: c.id, tag: c.tag, protocol: PROTOCOL, max_players: MAX_PLAYERS, quick_count: QUICK_CHAT_COUNT });
  },

  create(c, m) {
    if (rooms.size >= MAX_ROOMS) return error(c, "busy", "The server is busy right now. Try again in a minute.");
    const code = newCode();
    if (!code) return error(c, "busy", "Couldn't make a room code. Try again.");
    const room = { code, host: c.id, players: [], started: false, settings: { ...DEFAULT_SETTINGS }, history: [], banned: new Set(), created: Date.now() };
    applySettings(room, m.settings || {});
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
      if (!r.settings.public || r.started || r.players.length >= MAX_PLAYERS) continue;
      const h = clients.get(r.host);
      out.push({ code: r.code, host: h ? h.tag : "?", players: r.players.length, max: MAX_PLAYERS, mode: r.settings.mode, level: r.settings.level });
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
    const seed = Math.floor(Math.random() * 2 ** 31);
    broadcast(room, { t: "started", seed, host: room.host, settings: room.settings, players: room.players.map((id) => publicPlayer(clients.get(id))) });
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
  if (req.method === "GET" && req.url && req.url.split("?")[0].replace(/\/+$/, "") === "/status") {
    const online = [...clients.values()].filter((client) => client.hello).length;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ online }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const file = path.resolve(SITE_DIR, `.${pathname}`);
  const relative = path.relative(SITE_DIR, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
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

server.listen(PORT, () => log(`i-Pet Cyber Store 2096 lobby listening on port ${PORT}`));
PETI_EOF
$SUDO tee /opt/peti-lobby/filter.js >/dev/null <<'PETI_EOF'
// Chat and tag filter for i-Pet Cyber Store 2096.
// Players are likely to include kids, so this errs on the strict side:
//  - swear words and slurs are replaced with ****, including l33t spellings
//    (sh1t, $hit) and spaced-out letters (s h i t),
//  - anything that looks like personal contact info (phone numbers, email
//    addresses, links, @handles) is blanked, so nobody can swap details.
// Add words to BLOCKED (lower case, letters only). It matches whole words and
// words with extra letters on the end (shits, shitty), not words that merely
// contain it (so "class", "assume", "Scunthorpe" are fine).

const BLOCKED = [
  "fuck", "fuk", "fck", "shit", "shite", "bitch", "biatch", "cunt", "dick", "dickhead",
  "cock", "pussy", "asshole", "arsehole", "arse", "ass", "bastard", "bollocks",
  "wanker", "wank", "twat", "prick", "slut", "whore", "piss", "crap", "damn",
  "bullshit", "motherfucker", "jackass", "dumbass", "retard", "retarded", "spastic",
  "nigger", "nigga", "faggot", "fag", "kaffir", "kaffer", "chink", "spic", "kike",
  "tranny", "dyke", "paki", "coon", "gook", "wetback", "porn", "porno", "sex", "sexy",
  "nude", "nudes", "naked", "boobs", "tits", "penis", "vagina", "rape", "rapist",
  "kys", "killyourself", "nazi", "hitler", "poes", "naai", "doos", "fokof", "kak",
];

const LEET = { "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "+": "t" };

function normalise(word) {
  let out = "";
  for (const ch of word.toLowerCase()) {
    const c = LEET[ch] || ch;
    if (c >= "a" && c <= "z") out += c;
  }
  // "fuuuuck" -> "fuck"
  return out.replace(/(.)\1{2,}/g, "$1");
}

function isBlocked(word) {
  const n = normalise(word);
  if (n.length < 2) return false;
  for (const bad of BLOCKED) {
    if (n === bad) return true;
    if (bad.length >= 4 && n.startsWith(bad) && n.length <= bad.length + 3) return true;
    if (n.replace(/(.)\1+/g, "$1") === bad.replace(/(.)\1+/g, "$1") && bad.length >= 4) return true;
  }
  return false;
}

const CONTACT = [
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,                   // email
  /\bhttps?:\/\/\S+/gi,                             // links
  /\bwww\.\S+/gi,
  /\b[\w-]+\.(com|net|org|io|gg|co|za|me|tv|ly|app|xyz)\b\S*/gi,
  /(?:\+?\d[\s\-().]*){7,}/g,                       // phone numbers (7+ digits)
  /(^|\s)@\w{2,}/g,                                 // @handles
  /\b(discord|snap|snapchat|insta|instagram|tiktok|whatsapp|telegram|kik)\b\S*/gi,
];

function stars(s) {
  return "*".repeat(Math.max(3, Math.min(s.length, 8)));
}

function cleanText(text) {
  let t = String(text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  for (const re of CONTACT) t = t.replace(re, (m) => (m.startsWith(" ") ? " " : "") + stars(m.trim()));
  // Whole words.
  t = t.replace(/[^\s]+/g, (w) => (isBlocked(w) ? stars(w) : w));
  // Spaced-out words: "s h i t" / "f.u.c.k"
  t = t.replace(/\b(?:[a-z0-9$@!][\s._-]){2,}[a-z0-9$@!]\b/gi, (m) => (isBlocked(m.replace(/[\s._-]/g, "")) ? stars(m) : m));
  return t;
}

// A tag is a name shown above your pet and in the lobby. Letters, digits,
// spaces, _ and -; 3-14 characters; nothing blocked anywhere inside it
// (tags are short and permanent, so substring matches count here).
function cleanTag(tag) {
  let t = String(tag || "").replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim().slice(0, 14);
  if (t.length < 3) return null;
  const n = normalise(t);
  for (const bad of BLOCKED) if (bad.length >= 4 && n.includes(bad)) return null;
  for (const w of t.split(/[\s_-]+/)) if (isBlocked(w)) return null;
  if (/\d{5,}/.test(t)) return null;   // no phone-number tags
  return t;
}

module.exports = { cleanText, cleanTag, isBlocked };
PETI_EOF
$SUDO tee /opt/peti-lobby/package.json >/dev/null <<'PETI_EOF'
{
  "name": "peti-2296-lobby",
  "version": "1.0.0",
  "description": "Lobby, chat and relay server for i-Pet Cyber Store 2096 online play",
  "main": "lobby_server.js",
  "private": true,
  "scripts": {
    "start": "node lobby_server.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "ws": "^8.23.0"
  }
}
PETI_EOF
id -u peti >/dev/null 2>&1 || $SUDO useradd --system --home /opt/peti-lobby --shell /usr/sbin/nologin peti
(cd /opt/peti-lobby && $SUDO npm install --omit=dev --no-audit --no-fund -q)
echo "==> Installing website files"
$SUDO mkdir -p /opt/peti-lobby/site
if [[ "$SITE_MODE" == "folder" ]]; then
  $SUDO cp -a "$SITE_SOURCE"/. /opt/peti-lobby/site/
else
  $SUDO cp -a "$SITE_SOURCE/index.html" "$SITE_SOURCE/img" /opt/peti-lobby/site/
fi
$SUDO chown -R peti:peti /opt/peti-lobby

echo "==> Keeping it running (systemd service 'peti-lobby')"
$SUDO tee /etc/systemd/system/peti-lobby.service >/dev/null <<'PETI_EOF'
[Unit]
Description=i-Pet Cyber Store 2096 lobby server
After=network.target

[Service]
User=peti
WorkingDirectory=/opt/peti-lobby
Environment=PORT=8080
ExecStart=/usr/bin/node lobby_server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
PETI_EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable peti-lobby >/dev/null 2>&1
$SUDO systemctl restart peti-lobby

echo "==> Secure address (Caddy + free certificate) for $DOMAIN"
$SUDO tee /etc/caddy/Caddyfile >/dev/null <<PETI_EOF
$DOMAIN {
	reverse_proxy localhost:8080
}
PETI_EOF
$SUDO systemctl enable caddy >/dev/null 2>&1
$SUDO systemctl restart caddy

echo "==> Opening ports 80 and 443 on this server's own firewall"
# Oracle's Ubuntu images block everything except SSH in iptables.
for PORT in 80 443; do
  if ! $SUDO iptables -C INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null; then
    $SUDO iptables -I INPUT 5 -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null || \
      $SUDO iptables -I INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT
  fi
done
$SUDO netfilter-persistent save >/dev/null 2>&1 || true
if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 80/tcp >/dev/null; $SUDO ufw allow 443/tcp >/dev/null
fi

echo "==> Checking"
sleep 3
if curl -fsS http://localhost:8080/ >/dev/null; then
  echo "    Lobby server: running"
else
  echo "!!  Lobby server isn't answering. Logs: sudo journalctl -u peti-lobby -n 50"
fi
echo "    Getting the certificate can take a minute. Then open https://$DOMAIN in a browser:"
echo "    it should show the i-Pet Cyber Store 2096 website."
echo
echo "Done. The game's server address is:  wss://$DOMAIN"
echo "Useful later:  sudo systemctl restart peti-lobby   ·   sudo journalctl -u peti-lobby -f   ·   cat /opt/peti-lobby/reports.log"
