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
  connected. `mediaUrl`, if set, must be a URL the Mac mini can actually
  download from (publicly reachable, or at least reachable from wherever
  that Mac sits) — the agent fetches it and hands the file to Messages.app,
  it does not treat `mediaUrl` as anything Apple-specific.
- `POST /api/facetime` `{ deviceId, to, video? }` — start a FaceTime call.

## Image & voice message attachments

Inbound and outbound images/voice messages both go through the same
`mediaUrl` field — there's no separate attachment endpoint on the
company-facing API.

- **Outbound** (send an image or audio file): pass `mediaUrl` on
  `POST /api/send` pointing at wherever your CRM already hosts the file. The
  agent downloads it to a temp file, sends it via Messages.app, and deletes
  the temp file after.
- **Inbound** (a contact sends an image or voice message): the agent uploads
  it to this server (`POST /agent/attachments`, device-authenticated), which
  saves it to a Railway Volume and serves it back out at
  `<PUBLIC_URL_BASE>/media/<filename>` (see `ATTACHMENTS_DIR`/`PUBLIC_URL_BASE`
  in `server/.env.example`). That URL arrives as `mediaUrl` on the normal
  `message.inbound` webhook, same as any other inbound message, just with
  `body: null` and `mediaUrl` populated instead.
- **Voice messages specifically**: iMessage stores these as `.caf` on disk,
  which most browsers besides Safari can't play. The agent transcodes to
  AAC-in-MP4 (`.m4a`) before uploading, so `mediaUrl` always points at a
  universally-playable `audio/mp4` file — you never receive a raw `.caf`.
  These arrive with `kind: "AUDIO_MESSAGE"` (vs. `"IMESSAGE"` for images) on
  the webhook payload's `message` object, so your renderer can pick an
  `<audio>` player vs. an `<img>` without needing to sniff the file.

**Current limitations, not yet built:**
- Only image and audio attachments are handled (`image/*` and `audio/*`
  MIME types). Video, vCards, and other file types are silently skipped —
  nothing is stored or delivered for them yet.
- An image or voice message sent from another device on the same Apple ID
  (the user's iPhone, or Messages.app used directly on the Mac — see
  `message.sent_from_other_device` above) isn't uploaded/relayed yet, only
  text is handled on that path so far.
- If `ATTACHMENTS_DIR`/`PUBLIC_URL_BASE` aren't configured on the server,
  inbound attachment uploads fail outright (the agent logs the error) — text
  messaging is unaffected either way.
- Served files have no per-request auth — an unguessable filename is the
  only thing standing between the URL and the file. Fine for this project's
  current scale; revisit if that's not an acceptable tradeoff later.

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
  "isNewConversation": true,
  "message": { "id": "...", "kind": "IMESSAGE", "body": "hey", "mediaUrl": null, "createdAt": "..." }
}
```

Your website should treat this the way it'd treat any inbound-message
webhook: upsert the conversation, append the message, push to the open UI via
your own websocket/polling. `isNewConversation` tells you directly whether
this contact handle has ever messaged this device before — use it to decide
whether to open a new conversation tab rather than inferring it from your
own state.

A related event covers a case that isn't inbound at all: if "Messages in
iCloud" is on, a text sent from any of the user's own devices on that Apple
ID (their iPhone, or someone typing directly into Messages.app on the Mac)
syncs into the same `chat.db` the agent watches — and gets reported the same
way, since the CRM's view of the conversation should stay accurate regardless
of which device actually sent it:

```json
{
  "event": "message.sent_from_other_device",
  "conversationId": "...",
  "contactHandle": "+15551234567",
  "isNewConversation": true,
  "message": { "id": "...", "kind": "IMESSAGE", "body": "running 10 late", "createdAt": "..." }
}
```

Handle this exactly like `message.inbound` for conversation/tab purposes —
same `isNewConversation` semantics — but note `direction` on the stored
message is `OUTBOUND`, not `INBOUND`, if you're reading it back later via
`GET /api/conversations/:id/messages`. This only fires for a message that
wasn't sent through the CRM in the first place; anything sent via
`POST /api/send` is reported through `message.status` below instead, never
through this event.

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
