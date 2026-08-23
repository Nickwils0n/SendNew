# SendNew

An in-house iMessage/FaceTime relay (SendBlue-style) running on a Mac mini
fleet you own, plugged into your existing multi-company CRM website.

```
your CRM website  <--REST/webhook-->  server/  <--WebSocket-->  agent/ (DMG, one per Mac mini)
```

- **`server/`** — Node/Express + Postgres API, deploy to Railway. Talks to
  your website over REST + webhooks, and to every Mac mini over WebSocket.
- **`agent/`** — the Electron app packaged into the `.dmg`. Logs into
  `server/` with per-machine credentials, then drives `Messages.app` (iMessage
  send/receive) and `FaceTime.app` (calls) on that Mac mini.
- **`dmg-build/`** — packaging config + an MDM PPPC profile template for
  pre-authorizing the OS permissions the agent needs across the whole fleet.
- **`docs/`** — architecture and API contract.

Start with `docs/ARCHITECTURE.md`, then `server/README.md` to deploy to
Railway, then `dmg-build/README.md` to build and roll out the DMG.

## Status

Initial scaffold: schema, REST API, WebSocket hub, webhook delivery, the
Electron agent (login, iMessage send via AppleScript, chat.db inbound
watcher, FaceTime via URL scheme), and DMG/PPPC packaging docs are in place.
Not yet done: code-signing/notarization config (needs your Apple Developer ID
credentials), the actual MDM enrollment, and wiring your website's UI to this
API — happy to do the last one once I can see the website's codebase/repo.
