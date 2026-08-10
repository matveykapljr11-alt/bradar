# BRADAR backend

Turns the single-file mini-app (`../bradar.html`) into a real product: Telegram
auth, server-side storage, an authoritative media-plan engine (optionally
Claude-powered), and Telegram Stars payments. **Pure Node, zero dependencies.**

## What it does

| Endpoint | Purpose |
|---|---|
| `GET /` | serves the mini-app with the client integration injected |
| `GET /api/config` | AI on/off, catalog size, current user, active purchases |
| `POST /api/analyze` | brand + brief → media plan (engine, enriched by Claude if a key is set) |
| `POST /api/alternatives` | replacement candidates for a channel |
| `GET /api/state` | this user's saved plans + favourites |
| `POST /api/plans` · `DELETE /api/plans/:id` | save / delete a plan |
| `PUT /api/favs` | replace favourites |
| `POST /api/invoice` | create a Telegram Stars invoice link |
| `POST /api/telegram/webhook` | pre-checkout + successful-payment handling |

The mini-app file on disk is **never modified** — the backend injects
`/bradar-api.js` at serve time, which monkey-patches the app to use these APIs
and falls back to the offline behaviour when they're unavailable.

## Run locally

```bash
cd bradar-server
cp .env.example .env      # optional
npm run dev               # ALLOW_INSECURE_AUTH=1, no bot token needed
# open http://localhost:8080
```

No `npm install` needed (no dependencies).

Run the tests any time:

```bash
npm test      # engine (23) + client integration (19) + bot (7)
```

### The bot (`bot.js`)

Launches the Mini App and handles Stars payments. Needs `BOT_TOKEN` and `APP_URL`
(the https URL of the deployed mini-app) in `.env`.

```bash
node bot.js setmenu          # menu button opens BRADAR
node bot.js setcommands      # register /start
node bot.js                  # long-poll (dev; answers /start, approves payments, grants PRO)
# production instead of long-poll:
node bot.js setwebhook https://you/api/telegram/webhook
```

## Deploy: GitHub → Vercel

Vercel is serverless — no always-on process, no persistent disk. This repo is
already adapted:
- `api/index.js` + `vercel.json` run the same handler as a serverless function;
- plans & favourites live in the **browser** (localStorage + Telegram
  CloudStorage), so **no database is required to launch**;
- payments use the **webhook** (a serverless function). Durable PRO grants need
  Vercel KV — add it later; without it a grant is remembered only briefly.

**Steps**

1. Make the folder self-contained and commit it as its own repo root:
   ```bash
   cd bradar-server
   npm run prepare-deploy      # copies ../bradar.html → public/bradar.html
   git init && git add -A && git commit -m "BRADAR"
   git remote add origin https://github.com/<you>/bradar.git && git push -u origin main
   ```
   (Re-run `npm run prepare-deploy` and commit whenever `bradar.html` changes.)
2. **Vercel → Add New → Project → Import** that GitHub repo. Framework preset:
   **Other**. Deploy.
3. **Project → Settings → Environment Variables:**
   ```
   BOT_TOKEN   = <from @BotFather>
   XAI_API_KEY = <Grok key>
   XAI_MODEL   = grok-4
   APP_URL     = https://<your-project>.vercel.app/
   ```
   Redeploy after adding them.
4. Point Telegram at it (run locally, once, with the same BOT_TOKEN + APP_URL in
   your local `.env`):
   ```bash
   node bot.js setmenu
   node bot.js setwebhook https://<your-project>.vercel.app/api/telegram/webhook
   node bot.js setcommands
   ```
   In @BotFather: `/newapp` → Web App URL = `APP_URL`.
5. Open the bot → **Открыть BRADAR**. Done — plans build with Grok, save in the
   browser; export/contacts sit behind Stars.

*Want cross-device plans + durable payments?* Add the **Vercel KV** integration
(Storage → KV) — it injects `KV_REST_API_URL` / `KV_REST_API_TOKEN`. Then the
`store.js` swap to KV is a small follow-up (ask and I'll wire it).

*Prefer an always-on server (code runs unchanged, no serverless caveats)?* Use
**Render / Railway / a VPS**: connect the repo, set the same env vars, start
command `npm start`. The bot can then long-poll (`node bot.js`) instead of a webhook.

## Go real — checklist

1. **Bot & Mini App.** Create a bot in **@BotFather**, then `/newapp` and point
   the Web App URL at your deployed origin. Put the token in `.env` as
   `BOT_TOKEN`. With a token set, every `/api/*` call must carry a valid
   `initData` signature (validated in `server.js` → `verifyInitData`). Remove
   `ALLOW_INSECURE_AUTH` in production.
2. **Real AI.** Set one provider — `XAI_API_KEY` (Grok, default model
   `grok-4`, override with `XAI_MODEL`) or `ANTHROPIC_API_KEY` (Claude). If both
   are set, Grok wins. `/api/analyze` then asks the model to write the
   per-channel rationale, risks and strategy — grounded only in the metrics we
   pass, no invented numbers. Without a key it uses the deterministic engine.
   See `ai.js`.
3. **Real channel data — the important one.** Drop a JSON file at
   `data/channels.json` (or set `CHANNELS_FILE`) shaped as
   `{ "<vertical>": [ {id,name,cat,topic,subs,match,cpm,reach,eng,adShare,w, why?} ] }`.
   Any vertical you provide replaces the built-in seed for that vertical — **no
   code change**. This is where a TGStat / Telemetr / Telega.in export or your own
   DB dump plugs in. The `match` you store is only a base quality: the engine
   **re-scores every channel against the specific brand text** at request time
   (`scoreCandidates` in `engine.js`), so ranking already responds to the brand.
4. **Payments.** Set `BOT_TOKEN`, then either `node bot.js setwebhook
   https://you/api/telegram/webhook` (server handles payments) or run
   `node bot.js` (long-poll, dev). The mini-app already gates export/contacts
   behind PRO and buys it with Stars (`POST /api/invoice` + `tg.openInvoice`).
   Products live in `products.js`; grants are stored per user. Also run
   `node bot.js setmenu` so the chat menu button opens the app.
5. **Storage.** `store.js` is a JSON file (atomic writes) — fine for one node.
   Swap it for Postgres by keeping the same method signatures.
6. **Deploy.** Any Node host (Render / Fly / a VPS). Serve behind HTTPS
   (Telegram requires it). Point `MINIAPP_HTML` at the app file if it isn't at
   `../bradar.html`.

## Files

- `server.js` — HTTP server, routing, initData validation, static + injection, payments
- `engine.js` — plan engine: brand-aware matching, risks-from-metrics, drop-in catalog (**swap for real data via `data/channels.json`**)
- `ai.js` — optional AI enrichment (Grok/xAI or Claude/Anthropic, auto-selected by env)
- `store.js` — per-user JSON persistence (plans, favourites, Stars grants)
- `products.js` — Stars products (shared by server + bot)
- `bot.js` — Telegram bot: launches the Mini App, handles Stars payments
- `public/bradar-api.js` — client integration injected into the mini-app (server sync, AI upgrade, Stars paywall)
- `test-engine.js` · `test-client.js` · `test-bot.js` — `npm test`
