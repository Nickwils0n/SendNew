const { execFile } = require("child_process");
const path = require("path");
const { shell } = require("electron");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");
const CALL_WATCH_POLL_MS = 1500;
const CALL_WATCH_TIMEOUT_MS = 3 * 60 * 1000; // give up watching after 3 minutes either way
const CALL_WATCH_END_CONFIRM_POLLS = 2; // require 2 consecutive "no window" reads before declaring it over

function runAppleScript(scriptFile, args) {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      [path.join(SCRIPTS_DIR, scriptFile), ...args],
      { timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout?.trim());
      }
    );
  });
}

async function sendIMessage(to, body) {
  return runAppleScript("send-imessage.applescript", [to, body]);
}

async function sendIMessageAttachment(to, filePath) {
  return runAppleScript("send-imessage-attachment.applescript", [to, filePath]);
}

// FaceTime has no scriptable dictionary; the supported way to start a call
// programmatically is its URL scheme, which launches FaceTime.app and places
// the call. The very first FaceTime launch on a machine still needs a human
// to accept Apple's own sign-in/consent dialog once — see docs/ARCHITECTURE.md.
async function startFaceTime(to, video) {
  const scheme = video ? "facetime" : "facetime-audio";
  await shell.openExternal(`${scheme}://${encodeURIComponent(to)}`);
}

// Best-effort, undocumented: polls FaceTime.app's window title via System
// Events (Accessibility) and reports each raw value it sees to onStatus, so
// callers get *something* beyond "we told the OS to dial" — but this is UI
// scraping, not an API. The exact strings FaceTime shows while dialing/
// ringing/connected haven't been validated against a live call yet; treat
// early observations as data to refine this against, not ground truth.
// Requires Accessibility permission for this app (System Settings > Privacy
// & Security > Accessibility), separate from the Automation permission used
// for Messages.
function watchFaceTimeCall(onStatus) {
  let stopped = false;
  let lastValue = null;
  let consecutiveNoWindow = 0;
  let timer = null;

  async function poll() {
    if (stopped) return;
    let value;
    try {
      value = await runAppleScript("facetime-window-status.applescript", []);
    } catch (err) {
      onStatus({ raw: null, error: err.message });
      stop();
      return;
    }

    if (value !== lastValue) {
      lastValue = value;
      onStatus({ raw: value, error: null });
    }

    if (value === "NO_WINDOW" || value === "NOT_RUNNING") {
      consecutiveNoWindow += 1;
      if (consecutiveNoWindow >= CALL_WATCH_END_CONFIRM_POLLS) {
        stop();
        return;
      }
    } else {
      consecutiveNoWindow = 0;
    }

    timer = setTimeout(poll, CALL_WATCH_POLL_MS);
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
  }

  const timeout = setTimeout(stop, CALL_WATCH_TIMEOUT_MS);
  poll();

  return () => {
    clearTimeout(timeout);
    stop();
  };
}

module.exports = { sendIMessage, sendIMessageAttachment, startFaceTime, watchFaceTimeCall };
