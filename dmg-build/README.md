# Building & deploying the DMG

## 1. Build the app

```bash
cd agent
npm install
# point the built app at your Railway server before packaging:
echo "SENDNEW_SERVER_URL=https://<your-app>.up.railway.app" > .env
npm run dist
```

`electron-builder` outputs `dist/SendNew Agent-<version>.dmg`. You'll want a
paid Apple Developer ID to code-sign + notarize it (`electron-builder` handles
this automatically if `CSC_LINK`/`CSC_KEY_PASSWORD` and
`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` env vars are set) —
unsigned/un-notarized builds will be blocked by Gatekeeper on every Mac mini.

## 2. Per-device credentials

Each Mac mini needs its own username/password from the server (see
`server/README.md` → "provision your first company + device"). Two ways to
hand it to a machine:

- **Manual**: type it into the login window on first launch (what the app
  ships with by default).
- **Pre-seeded**: if you'd rather not type credentials on 20+ machines by
  hand, have your provisioning script drop a token straight into Keychain
  (`security add-generic-password`) before first launch, keyed the same way
  `keytar` reads it (`service: com.sendnew.agent`, `account: device-token`) —
  skips the login screen entirely. Ask if you want this wired up; it's a
  small addition to `main.js`.

## 3. Permissions at scale (the actual point of friction)

A `.dmg` cannot click "Allow" on the Automation / Full Disk Access prompts —
Apple blocks that categorically, for any installer. For a fleet you
administer, the fix is:

1. Enroll every Mac mini in an MDM (Apple Business Manager is free; pair it
   with a free-tier MDM like Mosyle Business, or Jamf/Kandji if you already
   pay for one).
2. Push `pppc-profile.mobileconfig` (fill in the `CodeRequirement` and UUIDs
   first — see comments in that file) to the whole fleet. This silently
   grants the agent's app bundle Full Disk Access + Automation rights for
   Messages.app/System Events, no click required.
3. FaceTime calls go out via the `facetime://` URL scheme, which doesn't need
   Automation permission — but the very first time FaceTime.app itself runs
   on a fresh Mac it needs a human to sign in with an Apple ID and accept
   Apple's own dialogs once. That's an Apple ID onboarding step, not
   something any profile can pre-skip.

Without an MDM, plan on physically clicking "Allow" once per Mac mini the
first time each prompt appears — after that it persists across reboots.

## 4. Rollout checklist per Mac mini

- [ ] Signed into the right iCloud account / iMessage-registered number
- [ ] SendNew Agent installed from the DMG (or MDM-pushed .pkg later)
- [ ] PPPC profile applied (Full Disk Access + Automation)
- [ ] Logged into the agent with its device credentials
- [ ] Device shows `online: true` via `GET /admin/devices` and is assigned to
      the right company
