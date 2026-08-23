# Building & deploying the DMG

## The easy path: GitHub Releases (recommended)

The DMG is built automatically by `.github/workflows/build-dmg.yml` on a
clean macOS GitHub Actions runner — no npm/Node/Electron setup needed on your
own machine at all, and it sidesteps every local quirk this project hit
during initial setup (native module ABI mismatches, Electron's installer
silently failing, npm's script-approval gating).

### One-time setup

1. In the repo's GitHub Settings → Secrets and variables → Actions, add a
   repository secret named `SENDNEW_SERVER_URL` set to your Railway server's
   URL (e.g. `https://sendnew-production.up.railway.app`). This gets baked
   into every build, so installed apps need **zero configuration** — no
   `.env` file, nothing to type beyond the device username/password.

### Cutting a release

```bash
git tag agent-v1.0.0
git push origin agent-v1.0.0
```

Pushing a tag matching `agent-v*` triggers the workflow. You can also trigger
it manually from the Actions tab (Run workflow) without a tag, which builds
from whatever's on the branch. Either way it publishes a GitHub Release with
the `.dmg` attached.

### Installing on a Mac mini

```bash
curl -L -o SendNew.dmg "https://github.com/Nickwils0n/SendNew/releases/latest/download/SendNew Agent-1.0.0.dmg"
open SendNew.dmg
```

(Or just download it from the Releases page in a browser.) Drag the app into
Applications.

**First launch only** — this build isn't code-signed (no Apple Developer ID
yet), so macOS Gatekeeper blocks a plain double-click the first time:

1. In Finder, **right-click** (or Control-click) `SendNew Agent.app` in
   Applications — do **not** double-click it.
2. Choose **Open** from the menu.
3. Click **Open** again in the warning dialog that appears.

After that one-time step, the app opens normally forever, including via
double-click or Login Items. This is a one-time step *per Mac mini*, not
per launch.

Once you have an Apple Developer ID ($99/year), tell me and I'll wire up
signing + notarization in the workflow — after that, this right-click step
goes away entirely for every future install.

## Local build (fallback, only if you can't use Actions)

```bash
cd agent
npm install
echo "SENDNEW_SERVER_URL=https://<your-app>.up.railway.app" > .env
npm run dist
```

**If `npm install`/`npm start` fails with "Electron failed to install
correctly"**: on some Mac/Node combinations, the JS-based zip extractor that
Electron's own installer uses internally fails silently partway through
unpacking `Electron.app` (exits 0, but only a couple of stray files land in
`node_modules/electron/dist/` — no error). The system `unzip` command doesn't
have this problem. Workaround:

```bash
cd agent
curl -L -o /tmp/electron.zip "https://github.com/electron/electron/releases/download/v31.3.0/electron-v31.3.0-darwin-x64.zip"
mkdir -p .electron-dist
unzip /tmp/electron.zip -d .electron-dist
npm start
```

`npm start` (see `package.json`) automatically picks up `.electron-dist/` if
it exists: it writes `node_modules/electron/path.txt` (the relative path to
the executable inside the `.app` bundle, `Electron.app/Contents/MacOS/Electron`
on macOS — required because a manual unzip doesn't create this file the way
Electron's own installer would) and points Electron at the folder via
`ELECTRON_OVERRIDE_DIST_PATH`, instead of relying on Electron's built-in
downloader. `.electron-dist/` is gitignored — repeat this on each machine that
hits the same failure; most won't need it.

**If it crashes with SIGSEGV on launch**: your native modules
(`better-sqlite3`, `keytar`) were built against your system Node's ABI
instead of Electron's. `npm install` runs `electron-rebuild` automatically
via its `postinstall` script to fix this — if you still hit it, run
`npx electron-rebuild -f -w better-sqlite3,keytar` by hand and retry.

## Per-device credentials: registering a new Mac mini

Three ways to get a Mac mini connected, from most to least hands-on for you:

### 1. Self-registration (recommended for a fleet)

Set `DEVICE_SETUP_CODE` on the server once (a shareable code, distinct from
`ADMIN_SECRET` — see `server/.env.example`). Then on any Mac mini, after
installing the DMG:

1. Open the app. On the login screen, click **"Setting up a brand-new Mac?
   Register it →"**.
2. Enter the setup code (and optionally a label like "Rack A #3").
3. Click **Register**. The app generates its own device credentials, signs
   in immediately, and shows you the generated username once for your
   records.
4. The device now exists on the server as **unassigned** — go assign it to
   a company the normal way:
   ```bash
   curl -X POST https://<railway-app>/admin/devices/<deviceId>/assign \
     -H 'x-admin-secret: <ADMIN_SECRET>' -H 'content-type: application/json' \
     -d '{"companyId":"<companyId>"}'
   ```
   (`GET /admin/devices` lists everything, newest first, if you need to find
   the ID.)

This is the flow for "someone downloads the app and registers a device
themselves" — they only ever need the setup code, never `ADMIN_SECRET`.

### 2. Manual (you provision ahead of time)

Run `POST /admin/devices` yourself (see `server/README.md`) and hand that
specific username/password to whoever's setting up that Mac — they type it
into the login window's normal sign-in form.

### 3. Pre-seeded (fully unattended)

If you'd rather not type credentials on 20+ machines by hand, have your
provisioning script drop a token straight into Keychain
(`security add-generic-password`) before first launch, keyed the same way
`keytar` reads it (`service: com.sendnew.agent`, `account: device-token`) —
skips the login/registration screen entirely. Ask if you want this wired up;
it's a small addition to `main.js`.

## Permissions at scale (the actual point of friction)

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
first time each prompt appears — after that it persists across reboots. The
app's tray icon → **Show Status…** window shows live permission status with
buttons that jump straight to the right System Settings pane.

## Rollout checklist per Mac mini

- [ ] Signed into the right iCloud account / iMessage-registered number
- [ ] SendNew Agent downloaded from the latest GitHub Release and installed
      (one-time right-click → Open, see above)
- [ ] PPPC profile applied (Full Disk Access + Automation), or granted
      manually on first prompt
- [ ] Logged into the agent with its device credentials
- [ ] Tray icon → Show Status… shows "Connected" and Full Disk Access
      "Granted"
- [ ] Device shows `online: true` via `GET /admin/devices` and is assigned to
      the right company
