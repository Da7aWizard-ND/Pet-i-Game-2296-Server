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
Free in Johannesburg, or a cheap Johannesburg VPS). Upload the complete
deployment folder so the setup script has every server module and the website:

    scp -r -i <key> "server/Pet-i Game 2296 Server" ubuntu@<server-ip>:~
    ssh -i <key> ubuntu@<server-ip> 'cd "Pet-i Game 2296 Server" && bash setup_server.sh <duckdns-name>'

It installs Node.js and Caddy, keeps the server running (systemd service
`peti-lobby`), opens ports 80/443, and gets a free certificate, so the game
connects to `wss://<duckdns-name>.duckdns.org`. The same address serves the
website at `/`. Run it again (with a newer script and website folder) to
update the server. The cloud provider's own firewall must also allow TCP 80
and 443 in.
The website's live lobby badge reads the online player count from `/status`.

Then put `wss://<duckdns-name>.duckdns.org` in `scripts/net.gd`
(`SERVER_URL`). The web build on an https page can only connect to `wss://`.

## Email accounts and profile sync

The in-game Account page links a verified email/password account to the
profile already on that device. A six-digit verification code is emailed and
expires after 15 minutes. After verification, the account receives 250 bolts
once. Registered gameplay progress—including bolts, wardrobe, special items,
challenges, badges and stats—is stored on the server and synced when online.
Device preferences remain local.

The website's **Sign in** button uses the same verified email and password.
Players can view their saved profile there, choose **Remember me on this
device** for a 30-day protected session, or request a six-digit email
password-reset code. Without that option, the site uses a browser-session
cookie and the server expires the session after 12 hours. The site never
saves the password. Password reset and account verification send mail through the GoDaddy Node.js
Hosting email gateway at `127.0.0.1:2525`. The sender identity is selected by
the platform, so the app does not need SMTP credentials or a configured
`from` address. Set `ACCOUNT_SECRET` in the GoDaddy app's environment variables
to a strong value generated with `openssl rand -hex 32`; do not commit it.
Restart or redeploy the app after setting it.

This email gateway is available only inside GoDaddy Node.js Hosting. Local
development and the Ubuntu `setup_server.sh` deployment cannot send account
emails through it; those deployments need an email-gateway adapter available
on their own host. Account registration and sign-in require a secure `wss://`
connection outside localhost.

## Files

- `setup_server.sh`: installs the bundled server modules and website on Ubuntu.
- `lobby_server.js`: WebSocket lobby, game relay and HTTP site server.
- `accounts.js`: email verification, password authentication and profile sync.
- `store.js`: persistent MySQL or JSON-file storage.
- `social.js`, `codes.js`, `config.js`: online profile, gift-code and live-config handlers.
- `filter.js`: chat/tag word filter and contact-info blocker. Add words to
  `BLOCKED` (lower case).
- `reports.log`: created when someone presses Report; each line has who
  reported whom and the last 15 chat messages from that room.

## Changing the message format

If you change what the game and server send each other, bump `PROTOCOL` in
both `lobby_server.js` and `scripts/net.gd`. Players on an old version then
get a clear "please update" message instead of strange bugs.
