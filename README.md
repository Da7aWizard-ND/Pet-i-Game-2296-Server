# i-Pet Cyber Store 2096 lobby server

The small program every online player connects to. It handles player tags,
game codes, the public games list, chat (filtered), Ready/Start, and passes
game messages between players. The host player's game runs the match itself.

## Try it on your own PC (no internet needed)

1. Install **Node.js** (the "LTS" version) from https://nodejs.org
2. Open a terminal in this `server` folder (in File Explorer: click the
   address bar, type `cmd`, press Enter).
3. First time only: `npm install`
4. Start it: `npm start`
   You should see `i-Pet Cyber Store 2096 lobby listening on port 8080`.
5. In Godot: Debug > Customize Run Instances > Enable Multiple Instances,
   set it to 2, then press F5. Two game windows open. In each, press
   **Play online**: create a game in one, join with the code in the other.

Leave the terminal open while you play; close it (or Ctrl+C) to stop.

## Putting it on the internet

Use `setup_server.sh` on a fresh **Ubuntu 24.04** server (Oracle Cloud Always
Free in Johannesburg, or a cheap Johannesburg VPS). Upload the setup script
and the website files:

    scp -r -i <key> setup_server.sh website ubuntu@<server-ip>:~
    ssh -i <key> ubuntu@<server-ip> "bash setup_server.sh <duckdns-name>"

It installs Node.js and Caddy, keeps the server running (systemd service
`peti-lobby`), opens ports 80/443, and gets a free certificate, so the game
connects to `wss://<duckdns-name>.duckdns.org`. The same address serves the
website at `/`. Run it again (with a newer script and website files) to update
the server. The cloud provider's own firewall must also allow TCP 80 and 443
in. The website's live lobby badge reads the online player count from `/status`.

Then put `wss://<duckdns-name>.duckdns.org` in `scripts/net.gd`
(`SERVER_URL`). The web build on an https page can only connect to `wss://`.

## Files

- `setup_server.sh`: one-step install/update for an Ubuntu server (regenerate
  it whenever `lobby_server.js` or `filter.js` change; it embeds them).
- `lobby_server.js`: the server.
- `filter.js`: chat/tag word filter and contact-info blocker. Add words to
  `BLOCKED` (lower case).
- `reports.log`: created when someone presses Report; each line has who
  reported whom and the last 15 chat messages from that room.

## Changing the message format

If you change what the game and server send each other, bump `PROTOCOL` in
both `lobby_server.js` and `scripts/net.gd`. Players on an old version then
get a clear "please update" message instead of strange bugs.
