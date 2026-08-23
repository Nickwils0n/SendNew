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

A second event fires every time an **outbound** message's status changes.
There is no optimistic `SENT` — the initial `202` response's `QUEUED` stands
until the agent's `chat.db` watcher actually *confirms* Messages.app created
the outgoing row (usually within a couple seconds), which is when `SENT`
fires. From there it may later correct to `DELIVERED` or `FAILED`:

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

**Build your UI against this, not an assumption that a `202` means sent.**
A message can sit at `QUEUED` for a few seconds before `SENT` fires, and can
go straight to `FAILED` without ever passing through `SENT` at all — e.g. if
Messages.app never confirms creating the row (`error` will read "Messages.app
never confirmed creating this message" in that case, distinct from a
post-send delivery failure). A `DELIVERED`/`FAILED` correction after `SENT`
can arrive up to ~30 seconds later, as its own separate webhook call with the
same `messageId`. Some sends (SMS, or iMessage to certain numbers) never get
a delivery receipt from Apple at all — no further event after `SENT` is not
an error, it just means `SENT` is the final known state.

One caveat: if the Mac mini's Full Disk Access permission isn't granted,
none of this can be verified at all, and the message is left at whatever
status it already had (typically `QUEUED` forever) rather than guessing.
Check device status/permissions if a company's messages seem to hang.

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
