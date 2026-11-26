"use strict";
// Auto-update distribution for the game, on the same server as the website.
//
//   GET /update.json            the manifest the game checks at launch
//   GET /update.json?channel=beta
//   GET /releases/<file>        the installers (with range support)
//
// Files live in server/releases and are written by server/tools/publish-update.js.
// The handler answers only those two paths and returns false for everything
// else, so lobby_server.js can carry on serving the site.

const fs = require("fs");
const path = require("path");

const RELEASES_DIR = path.join(__dirname, "releases");

const TYPES = {
  ".json": "application/json; charset=utf-8",
  ".exe": "application/octet-stream",
  ".apk": "application/vnd.android.package-archive",
  ".zip": "application/zip",
  ".pck": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

function reply(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

// Sends one file, with ETag and single-range support for big installers.
function serveFile(req, res, file, cacheControl) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return reply(res, 404, { "cache-control": "no-store" }, "Not found");
  }
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": cacheControl,
    "accept-ranges": "bytes",
    etag,
  };
  if (req.headers["if-none-match"] === etag) {
    return reply(res, 304, headers, undefined);
  }
  let start = 0;
  let end = stat.size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range) {
    start = range[1] ? Number(range[1]) : 0;
    end = range[2] ? Number(range[2]) : stat.size - 1;
    if (start > end || start >= stat.size) {
      headers["content-range"] = `bytes */${stat.size}`;
      return reply(res, 416, headers, undefined);
    }
    headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
    headers["content-length"] = String(end - start + 1);
    res.writeHead(206, headers);
  } else {
    headers["content-length"] = String(stat.size);
    res.writeHead(200, headers);
  }
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function createUpdates(options = {}) {
  const dir = options.releasesDir || RELEASES_DIR;
  const fallbackChannel = options.channel || "stable";

  return function updates(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return false;
    }
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      return false;
    }

    if (url.pathname === "/update.json") {
      // Only letters, digits, - and _ can name a channel (no ../ tricks).
      const asked = String(url.searchParams.get("channel") || fallbackChannel);
      const channel = asked.replace(/[^a-z0-9_-]/gi, "") || fallbackChannel;
      serveFile(req, res, path.join(dir, `${channel}.json`), "no-store");
      return true;
    }

    if (url.pathname.startsWith("/releases/")) {
      const name = path.basename(url.pathname.slice("/releases/".length));
      if (!name || name.startsWith(".")) {
        reply(res, 404, { "cache-control": "no-store" }, "Not found");
        return true;
      }
      // Installers never change once published, so they can be cached hard.
      serveFile(req, res, path.join(dir, name), "public, max-age=31536000, immutable");
      return true;
    }

    return false;
  };
}

module.exports = { createUpdates, RELEASES_DIR };
