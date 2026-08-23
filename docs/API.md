# API contract (server/)

All company-facing endpoints require header `x-api-key: <company.apiKey>`.
Admin endpoints require `x-admin-secret: <ADMIN_SECRET>` and are for your own
provisioning tooling, not the public website.

## Website → server

- `GET /api/devices` — Mac minis assigned to this company, with `online` status.
- `GET /api/conversations` — list conversations (one per device+contact pair).
- `GET /api/conversations/:id/messages` — full thread, oldest first.
- `POST /api/send` `{ deviceId, to, body, mediaUrl?, kind? }` — send an
  iMessage/SMS through a given Mac mini. Returns `202` with the created
  `message` row (status `QUEUED`), or `503` if that device isn't currently
  connected.
- `POST /api/facetime` `{ deviceId, to, video? }` — start a FaceTime call.

## Server → website (webhook)

POSTed to `Company.webhookUrl` whenever an agent reports an inbound message:

```json
{
  "event": "message.inbound",
  "conversationId": "...",
  "contactHandle": "+15551234567",
  "message": { "id": "...", "kind": "IMESSAGE", "body": "hey", "mediaUrl": null, "createdAt": "..." }
}
```

Your website should treat this the way it'd treat any inbound-message
webhook: upsert the conversation, append the message, push to the open UI via
your own websocket/polling.

## Agent (Mac mini) ↔ server

- `POST /agent/login` `{ username, password }` → `{ token, device }`. The
  agent stores `token` (macOS Keychain) and reconnects with it.
- `WS /agent/socket?token=<jwt>` — one persistent connection per device.
  - Agent → server: `heartbeat`, `inbound_message`, `status_update`, `log`.
  - Server → agent: `send_message`, `start_facetime`.

See `server/src/wsHub.js` for the exact payload shapes.
