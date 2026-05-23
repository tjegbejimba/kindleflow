# AGENTS.md — KindleFlow

Repo-level instructions for coding agents. Read this before doing anything
involving the NAS or production data.

## Deployment

KindleFlow is **not** deployed via GHCR or Watchtower. It runs from an on-NAS
git checkout at `/volume2/docker/projects/kindleflow/` and is built locally by
`docker compose build` (image name `kindleflow-kindleflow`). The Synology
NAS has no `git` binary.

Standard deploy flow:

1. `git push origin main` from the developer machine.
2. Sync the working tree to the NAS (the NAS can't `git pull` itself).
3. SSH in and run `sudo /usr/local/bin/docker compose build kindleflow &&
   sudo /usr/local/bin/docker compose up -d kindleflow`.
4. Verify with `curl -sSk https://kindleflow.tail217062.ts.net/api/config`.

The Tailscale sidecar (`tailscale-kindleflow`) is authenticated via persisted
state in `tailscale/state/`; it does not need `TS_AUTHKEY` set for restarts.

## ⚠️ Do not destroy `.env` or `data/` on the NAS

The NAS checkout contains **untracked-but-critical** files that are *not* in
git:

- `.env` — SMTP credentials, `INVITE_CODE`, `SUBSTACK_COOKIE`,
  `APP_BASE_URL`, `PORT=3060`, `COOKIE_SECURE=true`, etc. **There is no
  backup.** If this file is deleted, email login and Kindle delivery stop
  working until the user re-pastes the secrets by hand.
- `data/` — SQLite DB (`kindleflow.sqlite`), `invite-codes.txt`, generated
  EPUBs/PDFs. Losing this wipes every user account, delivery history, and
  invite code.
- `tailscale/state/` — Tailscale node identity. Losing it forces re-auth of
  the sidecar with a fresh `TS_AUTHKEY`.

### Rules for syncing code to the NAS

1. **Never use `rsync --delete`** against
   `/volume2/docker/projects/kindleflow/` (or any other NAS bind-mount
   directory). It will silently remove `.env`, `data/`, `tailscale/state/`,
   and anything else gitignored.
2. If a clean-sync is genuinely needed, use the explicit allow-list approach
   instead: rsync **without** `--delete`, then remove only the specific paths
   you intend to remove.
3. Always exclude at minimum: `node_modules`, `data`, `client/dist`, `dist`,
   `tailscale/state`, `.env`, `.DS_Store`. Mirror the project `.gitignore`.
4. Before any destructive sync, run with `--dry-run` first and read the
   output. If anything outside the repo's tracked files would be touched,
   stop.

A safe sync command template:

```sh
rsync -az \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='client/dist' \
  --exclude='dist' \
  --exclude='tailscale/state' \
  --exclude='.DS_Store' \
  ./ tjegbejimba@100.104.13.117:/volume2/docker/projects/kindleflow/
```

Note the absence of `--delete`. Add it only after a `--dry-run` confirms the
deletion set is exactly what you intend.

## SSH / docker on the NAS

- SSH as `tjegbejimba@100.104.13.117` (key auth). `admin@` has no key access.
- Docker requires the full path: `sudo /usr/local/bin/docker ...`.
- Compose files live at `/volume2/docker/projects/<app>-compose/` for most
  apps; KindleFlow is at `/volume2/docker/projects/kindleflow/` (no
  `-compose` suffix because it is also the git checkout).

## Local development

- `npm test` — vitest suite (must stay green).
- `npm run build` — `tsc --noEmit && vite build`. The deploy build inside
  Docker also runs this; if it fails locally it will fail on the NAS too.
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
- Bearer carve-out: `/api/tokens*` endpoints accept cookie sessions only,
  not bearer tokens. Every other endpoint accepts both.
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
