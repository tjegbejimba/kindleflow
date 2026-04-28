# KindleFlow

Self-hosted article-to-Kindle app for personal use. Paste an article URL, extract the readable content, preview it, generate a Kindle-friendly EPUB, then download it or automatically send it to your Kindle email address.

## Features

- Private/local-first Fastify + React app
- Server-side article fetching and extraction with Mozilla Readability
- SSRF-safe URL validation for direct URLs and redirects
- Sanitized article preview and EPUB content
- EPUB generation into a persistent data directory
- Invite-only email magic-link login
- Per-user Kindle email settings and automatic EPUB delivery
- Public Substack/RSS subscriptions with daily polling and dedupe
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
| `APP_BASE_URL` | Yes for email login | Public/local URL used in magic login links, for example `http://100.104.13.117:3060`. |
| `INVITE_CODE` | Yes for new users | Shared invite code required to create new accounts. |
| `COOKIE_SECURE` | No | Set `true` only when serving over HTTPS. |
| `DATA_DIR` | No | Directory for generated EPUB files; defaults to `data`. |
| `DB_PATH` | No | SQLite database path; defaults to `DATA_DIR/kindleflow.sqlite`. |
| `SMTP_HOST` | For email | SMTP server hostname. |
| `SMTP_PORT` | No | SMTP port; defaults to `587`. |
| `SMTP_SECURE` | No | Set `true` for implicit TLS, usually port `465`. |
| `SMTP_USER` | No | SMTP username, if your server requires auth. |
| `SMTP_PASS` | No | SMTP password or app password. |
| `SMTP_FROM` | For email | Approved sender address for Kindle delivery. |

If `SMTP_HOST` or `SMTP_FROM` are missing, users cannot receive magic login links or Kindle delivery emails. Do not commit real SMTP credentials.

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
COOKIE_SECURE=false
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-address@gmail.com
SMTP_PASS=your-google-app-password
SMTP_FROM=your-address@gmail.com
```

Generated EPUB files persist in:

```text
/volume2/docker/projects/kindleflow/data
```

The SQLite database is stored at:

```text
/volume2/docker/projects/kindleflow/data/kindleflow.sqlite
```

## Substack subscriptions

Users can add a public Substack URL such as `https://example.substack.com`; KindleFlow polls the feed at `/feed` daily and sends newly seen posts to the user’s Kindle address. Existing feed posts are marked as seen when the subscription is added so the app does not flood a Kindle with backlog.

Subscriber-only/private Substack posts are not implemented yet. Supporting them reliably will likely require an authenticated feed source, email-forwarding ingestion, or stored Substack session cookies, which is intentionally deferred.

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
