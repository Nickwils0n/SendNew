# SendNew — Architecture

Replicates SendBlue-style iMessage/FaceTime relay on top of a Mac mini fleet you
own, controlled from your existing web CRM.

## Components

```
Existing CRM website  <-- REST/webhooks -->  server/  <-- WebSocket -->  agent/ (on each Mac mini)
                                                 |
                                            Postgres (Railway)
```

### `server/` — Railway-hosted API (Node/Express + Prisma + Postgres)
- Source of truth: companies, devices (Mac minis), device<->company assignment,
  conversations, messages.
- Two auth surfaces:
  - **Company API key** — used by your existing website to send messages / read
    conversations / receive webhooks.
  - **Device credentials** (username+password, one per Mac mini) — issued by you,
    baked into the DMG at install time or entered on first launch. Exchanged for
    a short-lived JWT used to open the agent's WebSocket connection. This is the
    "identifier for logs" you described — every action a Mac performs is tied to
    its device row.
- Holds a live WebSocket per online agent. Outbound sends from the website hit
  `POST /api/messages/send`, the server looks up which device is assigned to
  that company/number and pushes the send command down that device's socket.
  Inbound messages/read-receipts from the agent come back up the same socket,
  get stored, and are forwarded to the company's webhook URL so your website's
  iOS-style UI can render them.

### `agent/` — the app that ships inside the DMG (Electron)
- First run: login window (username/password against `server/`). On success it
  stores the device token in macOS Keychain and drops into a menu-bar-only app
  (no dock icon needed).
- Runs a background WebSocket client to `server/`, plus:
  - **Send path**: JXA/AppleScript driving `Messages.app` (`osascript`) to send
    iMessages, and `FaceTime.app` via URL scheme (`facetime://`) for calls.
  - **Receive path**: watches `~/Library/Messages/chat.db` (SQLite, read-only)
    for new rows and forwards them to the server in near-real-time.
- On first run, if required TCC permissions (Automation for Messages/System
  Events, Full Disk Access for chat.db) are missing, it opens the exact System
  Settings pane and shows instructions — it **cannot** click "Allow" for the
  user; no app can, by OS design.

### `dmg-build/` — packaging + fleet provisioning
- `electron-builder` config that produces the `.dmg`.
- A **PPPC configuration profile** (`pppc-profile.mobileconfig`) template. Since
  you administer every Mac in the cluster, enroll them in an MDM (Apple Business
  Manager + any MDM, e.g. Jamf/Kandji/Mosyle/SimpleMDM) and push this profile —
  it silently pre-authorizes Automation/Accessibility/Full Disk Access for the
  agent's bundle ID, which is the actual (Apple-sanctioned) way to skip the
  click-through prompts for machines you own. This is the missing piece a DMG
  alone cannot do.

## Data model (see `server/prisma/schema.prisma`)
`Company`, `Device`, `Conversation`, `Message`.

## Open items to confirm with you
- Which MDM you already use (or want to stand up) for the PPPC profile push.
- Whether devices map 1:1 to phone numbers/iMessage accounts, or a Mac can host
  multiple numbers.
- Webhook shape your existing website expects (I've defined a default below in
  `docs/API.md`, easy to change).
