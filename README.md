# KindleFlow

Self-hosted article-to-Kindle app for personal use. Paste a public article URL or use the browser extension for paid Substack posts, generate a Kindle-friendly EPUB, then download it or automatically send it to your Kindle email address.

## Features

- Private/local-first Fastify + React app
- Server-side article fetching and extraction with Mozilla Readability
- SSRF-safe URL validation for direct URLs and redirects
- Sanitized article preview and EPUB content
- EPUB generation into a persistent data directory
- Generated local PNG covers embedded in each EPUB for nicer Kindle library thumbnails
- Invite-only email one-time-code login
- Per-user Kindle email settings and automatic EPUB delivery
- Kindle delivery history with SMTP response logging, test sends, latest-EPUB sends, and failed-send retry
- Public Substack/RSS subscriptions with daily polling and dedupe
- Browser extension for sending rendered paid Substack posts without copying cookies
- Private OPDS catalogs for KOReader or other OPDS-capable readers
- PWA manifest/icon for installing from the browser
- Docker Compose deployment for a Synology NAS

## Local development

```bash
npm install
npm test
```

Run the backend and frontend in two terminals:

```bash
npm run dev:server
```

```bash
npm run dev:client
```

Open `http://localhost:5173`. Vite proxies `/api` and `/files` to the Fastify backend on port `3000`.

If another local app already uses port `3000`, run the backend and proxy on a different port:

```bash
PORT=3001 npm run dev:server
KINDLEFLOW_SERVER_PORT=3001 npm run dev:client
```

Build and run production mode locally:

```bash
npm run build
npm start
```

Open `http://localhost:3000`.

## Configuration

Generated EPUBs and the SQLite database are stored in `DATA_DIR`, which defaults to `./data` locally and `/app/data` in Docker.

Copy `.env.example` to `.env` if you want local shell configuration:

```bash
cp .env.example .env
```

Environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | Host port for Docker Compose; defaults to `3000`. |
| `APP_BASE_URL` | Yes for email login | Public/local URL used in OPDS URLs and app links, for example `http://100.104.13.117:3060`. |
| `INVITE_CODES_FILE` | No | One-time invite-code file path; defaults to `DATA_DIR/invite-codes.txt`. |
| `INVITE_CODE` | No | Legacy shared invite code fallback when `INVITE_CODES_FILE` does not exist. |
| `COOKIE_SECURE` | No | Set `true` only when serving over HTTPS. |
| `SESSION_TTL_DAYS` | No | Browser login session lifetime; defaults to `180` and refreshes on visits. |
| `SUBSTACK_COOKIE` | No | Substack `Cookie` header value, without the `Cookie:` prefix, used when fetching paid Substack posts. |
| `SUBSTACK_COOKIE_HOSTS` | No | Comma-separated custom Substack hostnames that may receive `SUBSTACK_COOKIE`; `substack.com` and `*.substack.com` are included automatically. |
| `DATA_DIR` | No | Directory for generated EPUB files; defaults to `data`. |
| `DB_PATH` | No | SQLite database path; defaults to `DATA_DIR/kindleflow.sqlite`. |
| `SMTP_HOST` | For email | SMTP server hostname. |
| `SMTP_PORT` | No | SMTP port; defaults to `587`. |
| `SMTP_SECURE` | No | Set `true` for implicit TLS, usually port `465`. |
| `SMTP_USER` | No | SMTP username, if your server requires auth. |
| `SMTP_PASS` | No | SMTP password or app password. |
| `SMTP_FROM` | For email | Approved sender address for Kindle delivery. |

If `SMTP_HOST` or `SMTP_FROM` are missing, users cannot receive login codes or Kindle delivery emails. Do not commit real SMTP credentials.

Login sessions are stored in an HTTP-only browser cookie. Use one consistent app URL for both `APP_BASE_URL` and browsing the site because cookies are scoped to the exact host; for example, a login cookie from `http://100.104.13.117:3060` will not apply when visiting the Tailscale hostname.

For most users, paid Substack posts should be saved with the browser extension because the server cannot see a user's Substack browser login. As an admin-only fallback, set `SUBSTACK_COOKIE` to the browser cookie value from a logged-in Substack session, without the `Cookie:` prefix. KindleFlow sends it only to `substack.com`, `*.substack.com`, and hosts listed in `SUBSTACK_COOKIE_HOSTS` to avoid leaking it to unrelated article sites.

## Browser extension for paid Substack

The `extension/` directory contains the WebExtension source for saving pages that are already readable in your browser, including Substack premium posts. It does not read or upload Substack cookies; it captures the rendered page HTML, sends it to KindleFlow, generates the EPUB, and auto-sends it to Kindle when your KindleFlow profile has auto-send enabled.

To package store-ready builds:

```bash
npm run package:extension
```

This creates:

- `dist/extensions/kindleflow-chrome.zip` for Chrome Web Store
- `dist/extensions/kindleflow-firefox.zip` for Firefox Add-ons

To generate Chrome Web Store screenshots and listing copy:

```bash
npm run generate:extension-store-assets
```

This creates screenshots and listing text in `extension/store-assets/`.

Store listing notes:

- Summary: `Send paid Substack and other readable articles from your browser to KindleFlow.`
- Permission rationale: `activeTab` and `scripting` capture only the current page after the user clicks the extension; `storage` saves the KindleFlow app URL; host permissions let the popup call the configured KindleFlow server.
- Privacy note: the extension sends the rendered page HTML to the user's configured KindleFlow server. It does not collect analytics and does not read, store, or transmit Substack cookies.

To load it locally in Chrome/Chromium:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose “Load unpacked” and select this repo’s `extension/` directory.
4. Sign in to KindleFlow in the same browser.
5. Open a readable Substack post, click the KindleFlow extension, confirm the KindleFlow URL, and choose “Send current page”.

For local Firefox testing, load the same `extension/manifest.json` temporarily from `about:debugging#/runtime/this-firefox`.

The default extension URL is `https://kindleflow.tail217062.ts.net`. If you use a different KindleFlow URL, enter it in the popup. The extension will ask for permission to that app origin so it can call KindleFlow’s import/generate/send APIs. After generation, the popup shows download and manual “Send to Kindle” actions when needed.

### Gmail SMTP

Gmail is fine for this low-volume personal app. Use an app password, not your normal Google password:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-address@gmail.com
SMTP_PASS=your-google-app-password
SMTP_FROM=your-address@gmail.com
```

For Kindle delivery, each user adds their own `@kindle.com` address in the app. In Amazon’s Kindle settings, add `SMTP_FROM` to the “Approved Personal Document E-mail List”; otherwise Amazon will reject the EPUB attachment.

KindleFlow records each Kindle email attempt in delivery history. A `sent` status means the configured SMTP server accepted the message; Amazon can still reject or delay it afterward if the sender is not approved, the Kindle address is wrong, or Personal Document delivery has a problem. Use “Send test EPUB” to validate the Amazon side, “Send latest EPUB now” to re-send the newest generated item, and “Retry” on failed delivery rows after fixing configuration.

## Docker Compose deployment

On the NAS, place this project under your Docker projects directory:

```bash
mkdir -p /volume2/docker/projects/kindleflow
cd /volume2/docker/projects/kindleflow
```

Copy the project files there, create an optional `.env`, then start it:

```bash
docker compose up -d --build
```

Example NAS `.env` for Tailscale access on port `3060`:

```env
PORT=3060
APP_BASE_URL=http://100.104.13.117:3060
INVITE_CODE=choose-a-private-invite-code
INVITE_CODES_FILE=/app/data/invite-codes.txt
COOKIE_SECURE=false
SESSION_TTL_DAYS=180
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-address@gmail.com
SMTP_PASS=your-google-app-password
SMTP_FROM=your-address@gmail.com
```

For HTTPS over the NAS Tailscale node, use the MagicDNS HTTPS URL as `APP_BASE_URL` and set secure cookies:

```env
APP_BASE_URL=https://tjnas.tail217062.ts.net
COOKIE_SECURE=true
```

Then proxy Tailscale HTTPS to the local Docker port:

```bash
tailscale serve --bg --https=443 http://localhost:3060
```

On Synology, if `tailscale serve` reports `serve config denied`, grant the SSH user operator access once from an admin shell:

```bash
sudo tailscale set --operator=tjegbejimba
```

Then rerun the `tailscale serve` command and restart KindleFlow with the HTTPS `APP_BASE_URL`/`COOKIE_SECURE` values.

Generated EPUB files persist in:

```text
/volume2/docker/projects/kindleflow/data
```

## Tailscale app hostname

KindleFlow can also run behind a dedicated Tailscale sidecar node named `kindleflow`, matching the pattern used by `alisterr`. This keeps the NAS hostname as `tjnas` while making the app available at `https://kindleflow.tail217062.ts.net`.

Set a reusable/pre-authorized Tailscale auth key in `.env`:

```env
COMPOSE_PROFILES=tailscale
TS_AUTHKEY=tskey-auth-...
APP_BASE_URL=https://kindleflow.tail217062.ts.net
COOKIE_SECURE=true
```

The Compose stack starts `tailscale-kindleflow` and loads `tailscale/config/serve.json` so Tailscale HTTPS proxies to the app container on port `3000`. The legacy host-port path still works through `PORT=3060`, but OPDS URLs should use `APP_BASE_URL`.

The SQLite database is stored at:

```text
/volume2/docker/projects/kindleflow/data/kindleflow.sqlite
```

One-time invite codes can be stored at:

```text
/volume2/docker/projects/kindleflow/data/invite-codes.txt
```

Put one code per line. When a new user signs up, KindleFlow removes that code from `invite-codes.txt` and appends it to `invite-codes.used.txt` with the signup email and timestamp. If the invite-code file exists but is empty, new signups remain invite-gated and no new account can be created until another code is added.

## Kindle approved sender

KindleFlow shows the configured `SMTP_FROM` sender in the profile screen with a copy button and a link to Amazon’s Kindle settings. Each user still needs to add that sender to their Amazon “Approved Personal Document E-mail List”; Amazon does not provide a safe public URL that pre-fills this value automatically.

## Substack subscriptions

Users can add a public Substack URL such as `https://example.substack.com`; KindleFlow polls the feed at `/feed` daily and sends newly seen posts to the user’s Kindle address. Existing feed posts are marked as seen when the subscription is added so the app does not flood a Kindle with backlog.

Each user can choose how many days of subscription delivery history to keep, from 1 to 365 days. Daily polling skips posts older than that setting and prunes old delivered-post records plus generated EPUB files.

Subscriber-only/private Substack posts are not implemented yet. Supporting them reliably will likely require an authenticated feed source, email-forwarding ingestion, or stored Substack session cookies, which is intentionally deferred.

## OPDS reader sync

Each signed-in user has a private OPDS catalog URL in the “Reader sync” section of the web UI. OPDS is useful for KOReader and other ebook apps that can browse catalogs directly.

Typical KOReader flow:

1. Open KOReader.
2. Open OPDS catalog settings.
3. Add a new catalog using the private KindleFlow OPDS URL.
4. Browse “Recent” or “Subscriptions.”
5. Download EPUBs directly to the reader.

The OPDS URL contains a private access token. Keep it secret. If it leaks, use “Rotate OPDS URL” in KindleFlow and update your reader with the new URL.

### Kindle jailbreak note

KOReader on Kindle requires a jailbroken Kindle plus launcher tooling such as KUAL/MRPI. For a Kindle 11th generation 2024 on firmware `5.19.3.0.1`, do not attempt WinterBreak or AdBreak unless the upstream KindleModding/MobileRead documentation changes:

- WinterBreak is documented as not working on firmware `5.18.1` and newer.
- AdBreak is documented for firmware `5.18.1` through `5.18.5.0.1`.
- Firmware downgrades on modern Kindles are generally blocked by Amazon’s update/anti-rollback protections and are not recommended.

KindleFlow’s OPDS support is still useful before a Kindle jailbreak is available because it works with other OPDS readers and keeps the server-side newsletter library ready.

To update after changing code:

```bash
docker compose up -d --build
```

To view logs:

```bash
docker compose logs -f kindleflow
```

## SSRF protections

KindleFlow validates URLs before fetching and validates every redirect target. It rejects:

- non-HTTP(S) schemes
- localhost and single-label/internal hostnames
- `.local`, `.lan`, `.internal`, `.home`, and `.test` hostnames
- loopback, private LAN, link-local, carrier-grade NAT, benchmarking, multicast/reserved IPv4 ranges
- IPv6 loopback, unique-local, link-local, and multicast ranges

Article images are stripped from generated content for the MVP so the EPUB generator does not fetch arbitrary image URLs found inside article HTML.
