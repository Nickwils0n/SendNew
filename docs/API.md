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

## Admin (your CRM website's backend → server, `x-admin-secret`)

These exist so your CRM's backend can build a self-serve "Send New"
connections panel for each company, without you manually running curl for
every signup:

- `GET /admin/companies/:id` — company details + its assigned devices
  (`label`, `phoneNumber`, `online`, `status`). Use this to render "assigned
  phone number and iCloud" status.
- `POST /admin/companies/:id/regenerate-key` — rotates and returns a new
  `apiKey`. Wire this to a "Regenerate API key" button; the old key stops
  working immediately.
- `PATCH /admin/companies/:id` `{ name?, webhookUrl? }`.

**Keep `ADMIN_SECRET` server-side only** in wayne-crm (an env var on its own
backend) — never ship it to the browser. The company's own dashboard talks to
wayne-crm's *own* backend routes, which then call these admin endpoints on
`server/` using that secret.

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
