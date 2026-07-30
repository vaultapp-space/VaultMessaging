# Vault

A privacy-first, end-to-end encrypted messenger. Zero PII, zero server-side plaintext, messages auto-delete within 24 hours.

## What's here

- **`client/`** — Svelte 5 + Vite frontend. All cryptography (Double Ratchet, X3DH, Sender Keys, AES-GCM) runs client-side via Web Crypto; key material never leaves the browser except as passphrase-encrypted backups.
- **`server/`** — Fastify backend. Acts as a blind relay: it stores and forwards encrypted blobs, manages WebSocket delivery, and never has access to plaintext or private keys.
- **`docs/`** — design notes.
- **`ecosystem.config.cjs`** — PM2 process config for production deployment.

## Core features

- End-to-end encrypted 1:1 messaging (Double Ratchet + X3DH) and group messaging (Sender Keys)
- Ephemeral, burn-on-read attachments with chunked upload/download
- E2EE voice/video calling over WebRTC, with encrypted SDP/ICE signaling relayed through the server
- A persistent mini call bar — calls stay connected while you navigate between conversations
- Passphrase-encrypted cloud vault backup and optional WebAuthn/biometric unlock
- QR-code based multi-device identity sync
- Web Push notifications (VAPID) for offline delivery

## Tech stack

| Layer | Stack |
|---|---|
| Frontend | Svelte 5, Vite, Tailwind CSS |
| Backend | Fastify, PostgreSQL, Redis |
| Crypto | Web Crypto API (ECDH/ECDSA P-256, AES-GCM, HKDF, Argon2id) |
| Realtime | WebSocket, WebRTC |

## Getting started

### Prerequisites
- Node.js 20+
- PostgreSQL and Redis running locally (or reachable via env vars)

### Server
```bash
cd server
npm install
cp .env.example .env   # set PGHOST/PGUSER/PGPASSWORD/PGDATABASE, REDIS_HOST, JWT_SECRET, TURN_SECRET, CLIENT_ORIGIN
npm run dev
```

### Client
```bash
cd client
npm install
npm run dev
```

The Vite dev server proxies `/api` and `/ws` to `http://localhost:3001` by default (see `client/vite.config.js`).

## Configuration

Server configuration lives in `server/src/config.js` and is sourced entirely from environment variables. In production, the server refuses to boot if `JWT_SECRET` or `TURN_SECRET` are left at their insecure development defaults — set real values before deploying (see `ecosystem.config.cjs` for the PM2 production setup, which reads secrets from the shell environment rather than hardcoding them).

## Security model

- The server never sees plaintext messages, attachments, or private keys — only encrypted blobs and routing metadata.
- All long-term and session key material lives in volatile browser memory by default; nothing is written to disk unless the user explicitly enables encrypted local/cloud backup.
- Messages carry a server-enforced 24-hour TTL and are hard-deleted by a periodic reaper.

This is an active project — see `docs/` for design notes on individual subsystems.
