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

A second event fires every time an **outbound** message's status changes —
including the transition from the initial `202` response's implicit `QUEUED`
to `SENT`, and, if the agent's `chat.db` watcher resolves it, a later
correction to `DELIVERED` or `FAILED`:

```json
{
  "event": "message.status",
  "messageId": "...",
  "conversationId": "...",
  "kind": "IMESSAGE",
  "status": "FAILED",
  "error": "chat.db error code 22",
  "updatedAt": "..."
}
```

**This is the piece to build against if your UI shows a message as "sent"
immediately and never updates it.** `SENT` only means the agent successfully
handed the message to Messages.app — not that it was delivered. A real
`DELIVERED` or `FAILED` correction, when Apple reports one, can arrive up to
~30 seconds after the initial `SENT` event, as its own separate webhook call
with the same `messageId`. Some sends (SMS, or iMessage to certain numbers)
never get a delivery receipt from Apple at all — no second event is not an
error, it just means `SENT` is the final known state.

A third event fires zero or more times per FaceTime call, whenever the
agent's window-title watcher observes a change:

```json
{
  "event": "facetime.status",
  "messageId": "...",
  "conversationId": "...",
  "kind": "FACETIME_VIDEO",
  "raw": "Calling +15551234567…",
  "error": null,
  "observedAt": "..."
}
```

**Treat `raw` as informational, not authoritative.** It's the literal text
of FaceTime.app's window title, read via Accessibility/UI-scripting — there
is no official Apple API for FaceTime call state. The exact strings it
returns for "ringing" vs. "connected" vs. "ended" haven't been validated
against real calls yet; expect to observe actual values from your webhook
logs and adjust any UI you build around them accordingly. `raw` may also be
`"NO_WINDOW"` (FaceTime window closed — likely call ended) or `"NOT_RUNNING"`.
No event fires at all if Accessibility permission hasn't been granted to the
agent.

**Verifying it's really from SendNew:** every delivery carries an
`x-sendnew-signature: sha256=<hex>` header, computed as
`HMAC-SHA256(rawRequestBody, company.webhookSecret)`. `webhookSecret` is
returned alongside `apiKey` in `GET /admin/companies/:id` (admin-secret gated
— fetch and store it server-side the same way you store `apiKey`, never
expose it to the browser). Your receiver must recompute the HMAC over the
*raw, unparsed* body and compare with a constant-time check
(`crypto.timingSafeEqual` in Node) before trusting the payload — reject
anything that doesn't match or is missing the header.

## Agent (Mac mini) ↔ server

- `POST /agent/login` `{ username, password }` → `{ token, device }`. The
  agent stores `token` (macOS Keychain) and reconnects with it. This is for a
  device you already provisioned via `POST /admin/devices`.
- `POST /agent/register` `{ setupCode, label? }` → `{ token, credentials, device }`.
  Self-service registration for a brand-new Mac mini, used by the DMG's
  "Register this device" flow so you don't have to run `admin/devices` curl
  commands by hand for every machine. Requires the server's
  `DEVICE_SETUP_CODE` env var to be set — `setupCode` must match it exactly,
  or the endpoint returns `503` (unset) / `401` (wrong code). Creates a new,
  **unassigned** device with a randomly generated username/password; assign
  it to a company afterward the normal way (`POST /admin/devices/:id/assign`).
  `credentials` is returned once for the operator's own records — the app
  itself only needs the `token` it already stored.
- `WS /agent/socket?token=<jwt>` — one persistent connection per device.
  - Agent → server: `heartbeat`, `inbound_message`, `status_update`, `log`.
  - Server → agent: `send_message`, `start_facetime`.

See `server/src/wsHub.js` for the exact payload shapes.
