# AGENTS.md — KindleFlow

Repo-level instructions for coding agents. Read this before doing anything
involving the NAS or production data.

## Auth

KindleFlow uses **header-trust authentication only**. There is no login UI,
no email-code flow, no cookie sessions.

- The app trusts `X-Auth-Request-Email` and display name headers from an
  upstream reverse proxy (Tinyauth / Caddy / Cloudflare Access /
  `pwa-auth-bridge`). `X-Auth-Request-Name` is preferred when present, with
  `X-Auth-Request-User` as fallback.
- Unknown emails are JIT-provisioned as new users.
- `Authorization: Bearer kf_pat_*` PATs still work end-to-end for CLI and
  MCP. They're issued from the web UI (Settings → API tokens) once the user
  is logged in via the proxy.
- OPDS uses URL path tokens (`/opds/:token/...`) — bypasses header auth.
- `/__auth/*` belongs to `pwa-auth-bridge`; the app must not serve the SPA
  fallback for those paths.

**The container MUST only be reachable through the trusted proxy.** Anyone
who can hit the container directly can spoof identity by setting the email
header. Two layers of defense:

1. Network: don't expose host ports once Caddy/Tinyauth is in front; keep
   the app on a private Docker network reachable only from the proxy.
2. Optional shared secret: set `AUTH_TRUSTED_PROXY_SECRET` and configure the
   proxy to inject a matching `X-Auth-Request-Proxy-Secret` header. The app
   then refuses header-auth requests without it.

For local dev, set `AUTH_DEV_BYPASS=true` and `NODE_ENV=development`. The
app then treats every unauthenticated request as `AUTH_DEV_EMAIL`
(default `dev@kindleflow.local`). `loadConfig` refuses to start if
`AUTH_DEV_BYPASS=true` is combined with `NODE_ENV=production`.

## Deployment

KindleFlow deploys via **GHCR + Watchtower**. Pushes to `main` publish
`ghcr.io/tjegbejimba/kindleflow:latest`; the NAS compose file pulls that image
and Watchtower is allowed to update the container.

The NAS compose/runtime directory is still `/volume2/docker/projects/kindleflow/`
for continuity with the existing `.env`, `data/`, and `tailscale/state/`
locations. Treat it as a production runtime directory, not a source checkout.

Standard deploy flow:

1. `git push origin main` from the developer machine.
2. Wait for the `Release image` GitHub Actions workflow to publish the GHCR
   image.
3. Let Watchtower update it on the normal schedule, or SSH in for an immediate
   deploy:
   `cd /volume2/docker/projects/kindleflow && sudo /usr/local/bin/docker compose pull kindleflow && sudo /usr/local/bin/docker compose up -d kindleflow`.
4. Verify with `curl -sSk https://kindleflow.tail217062.ts.net/api/config` and
   `curl -sSkI https://kindleflow.tjegbejimba.com/`.

The Tailscale sidecar (`tailscale-kindleflow`) is authenticated via persisted
state in `tailscale/state/`; it does not need `TS_AUTHKEY` set for restarts.

## ⚠️ Do not destroy `.env` or `data/` on the NAS

The NAS runtime directory contains **untracked-but-critical** files that are
*not* in git:

- `.env` — SMTP credentials, `AUTH_TRUSTED_PROXY_SECRET`, `SUBSTACK_COOKIE`,
  `APP_BASE_URL`, `PORT=3060`, etc. **There is no backup.** If this file is
  deleted, Kindle delivery stops working until the user re-pastes the secrets
  by hand.
- `data/` — SQLite DB (`kindleflow.sqlite`) and generated EPUBs/PDFs. Losing
  this wipes every user account and delivery history.
- `tailscale/state/` — Tailscale node identity. Losing it forces re-auth of
  the sidecar with a fresh `TS_AUTHKEY`.

### Rules for touching the NAS runtime directory

1. Do not sync the source tree as the normal deploy path. Code deploys by GHCR
   image now.
2. **Never use `rsync --delete`** against
   `/volume2/docker/projects/kindleflow/` or any NAS bind-mount directory. It
   can silently remove `.env`, `data/`, `tailscale/state/`, and other
   production-only state.
3. If you need to update compose/config on the NAS, copy only the intended file
   and preserve `.env`, `data/`, and `tailscale/state/`.
4. Before any destructive cleanup, run with `--dry-run` first and read the
   output. If anything outside the intended file set would be touched, stop.

## SSH / docker on the NAS

- SSH as `tjegbejimba@100.104.13.117` (key auth). `admin@` has no key access.
- Docker requires the full path: `sudo /usr/local/bin/docker ...`.
- Compose files live at `/volume2/docker/projects/<app>-compose/` for most
  apps; KindleFlow remains at `/volume2/docker/projects/kindleflow/` to
  preserve its existing production data layout.

## Local development

- `npm test` — vitest suite (must stay green).
- `npm run build` — `tsc --noEmit && vite build`. The release workflow and
  Docker image build also run this; if it fails locally it will fail before
  publishing the NAS image.
- `npm run dev:server` / `npm run dev:client` for local iteration.

## CLI / MCP

KindleFlow ships a CLI (`kindleflow`) and an MCP server (`kindleflow-mcp`)
that wrap the HTTP API. They are **not** deployed to the NAS — they're
intended to run on user machines (cron, scripts, Claude Desktop, etc.) against
the existing NAS server.

- Source: `cli/`, `mcp/`, `shared/`.
- Build: `npm run build:cli` and `npm run build:mcp` produce
  `dist/cli/cli/index.js` and `dist/mcp/mcp/server.js`.
- Auth: bearer tokens minted in the web UI (Settings → API tokens). Stored
  as SHA-256 hashes in the `api_tokens` SQLite table; plaintext is shown
  once on creation only.
- Browser carve-out: `/api/tokens*` endpoints accept the browser's
  header-auth user only, not bearer tokens. Every other endpoint accepts
  both header-auth and bearer.
- Server orchestration endpoint `POST /api/articles/send-url` is the single
  call CLI/MCP make for `send` / `send_article`; it runs
  fetch → generate → (send | skip) honouring `sendMode: "auto" | "force" |
  "none"` so the client lib never has to re-implement the auto-send rules
  in `/api/articles/fetch` and `/api/articles/generate`.
- See `README.md` for full CLI/MCP usage and Claude Desktop config.

## Pre-merge checklist

Before pushing to `main` (which is also production):

1. `npm test` passes.
2. `npm run build` passes.
3. If touching anything that reads/writes `data/` schema or filenames, think
   about backwards compatibility — production data is live.
