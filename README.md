# Produce Seller Message Board (deployable)

A self-contained, invite-only, anonymous message board for sellers to post produce
experiences and concerns. All sellers share the same board. Built with **Node.js
built-in modules only** — zero npm dependencies.

## Run locally (no accounts needed)

Requirements: Node.js 18+.

```bash
cd deployable
PORT=3000 DATA_DIR=./data node server.js
```

Open http://localhost:3000 on your phone or computer.

- First run opens **Owner setup**: set an **owner code** (keep private) and a **seller
  invite code** (share only with sellers). Nothing is pre-set or hardcoded.
- Data lives in `DATA_DIR` (`store.json` + `uploads/` images). It survives restarts
  because it is plain files on disk.

## Deploying (so sellers can actually open it)

The Muse artifact version cannot be shared with sellers, so this package exists to
give you a real, hosted copy. **Devin must create the host account in his own name —
no accounts were created during this build.**

1. Create an account at a Node host with persistent storage (e.g. Render, Railway,
   or Fly.io). These are examples, not endorsements — any host that runs a Node
   web service with a persistent disk/volume works.
2. Deploy this folder as a web service:
   - Build/start command: `node server.js`
   - Add a **persistent disk/volume** and mount it at e.g. `/data`.
3. Set environment variables on the service:
   - `PORT` — set automatically by most hosts; the server reads it.
   - `DATA_DIR=/data` (the mounted volume path) — **required** so posts, codes,
     and pictures survive restarts and redeploys.
4. Open the service URL on your phone, complete owner setup, then share the
   **seller invite code** (not the URL alone — the board needs the code) with a
   small pilot group first.
5. HTTPS: enable the host's automatic TLS for your service (usually a toggle).
   Sellers' browsers will warn otherwise, and camera uploads on iOS require HTTPS.

## How future changes are deployed

- Change the code here, push/redeploy the service. **Data is untouched** as long as
  the `DATA_DIR` volume stays attached — posts, codes, and admins persist.
- Day-to-day moderation (delete posts, rotate invite code, add/remove admins) is
  done inside the app itself — no redeploy needed.
- If a future change alters the data format, convert `store.json` carefully first
  (back up the `DATA_DIR` volume) so nothing is lost.

## Env vars

| Var      | Default   | Meaning                                    |
|----------|-----------|--------------------------------------------|
| PORT     | 3000      | Port to listen on                          |
| DATA_DIR | ./data    | Persistent storage dir (mount a volume here in prod) |
| BOARD_OWNER_CODE | (unset) | Optional seed — see below |
| BOARD_SELLER_CODE | (unset) | Optional seed — see below |

## Free-tier workaround (seeded codes)

On hosts without persistent storage (e.g. Render's free tier), the data dir can
be wiped on restart, which would reset the board to the owner-setup screen.
Setting **both** `BOARD_OWNER_CODE` and `BOARD_SELLER_CODE` in the host's
environment settings seeds the board on every boot: if the saved store has no
completed setup, the board starts already set up with these codes, and the
token-signing secret and invite version are derived deterministically from
them — so owner/seller sign-ins and existing sign-in tokens survive restarts
and data-dir wipes. The in-app setup screen is disabled while seeded.

Limits while running seeded on a free/ephemeral host: posts, pictures, replies,
and admins added in-app still live in the data dir and are lost when it is
wiped; changing the seller code means changing `BOARD_SELLER_CODE` in the host
settings (an in-app rotation is overwritten by the seed after a wipe). Once a
persisted store (paid disk) has a completed setup, that store wins and the
seed vars are ignored, so upgrading later needs no code change — just attach
the disk; the seed can then be removed from the environment.

## Features

- Phone-friendly single page.
- Invite-only gate; owner setup on first run; codes stored hashed (scrypt).
- Fully anonymous posts — "Anonymous" only, nothing in seller-visible data links a post to a person.
- Composer: Experience/Concern, "Produce item (optional — add APN)" field, optional
  one picture per post (camera/gallery, preview, JPEG/PNG/WebP/GIF, ≤ 2 MB, stored server-side).
- Feed: newest first, search (matches APN text too), type filter, replies, Report button.
- Profanity filter (plain-English refusal), per-user posting throttle.
- Auto-hide: 2 reports hide a post from sellers completely; admins see it flagged
  "Auto-hidden"; Restore clears the report count; Delete removes it (and its picture).
- Auto-delete: posts, replies, and pictures removed 14 days after posting; notice
  shown in the board header.
- Multi-admin: owner adds/removes admins by individual admin code; admins moderate
  and rotate the invite code; only the owner manages admins; revoking kills an
  admin's access instantly.
