const fs = require("fs");
const { execFile } = require("child_process");
const { shell } = require("electron");
const { CHAT_DB_PATH } = require("./chatDbWatcher");

// macOS will not let any app auto-click its own TCC ("Allow"/"Don't Allow")
// prompts — that's an intentional Apple security boundary, DMG or not. What
// this module *can* do: detect what's missing and send the human straight to
// the right System Settings pane. For a fleet you administer, the real fix
// is pushing a PPPC configuration profile via MDM — see dmg-build/README.md.

function canReadChatDb() {
  try {
    fs.accessSync(CHAT_DB_PATH, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function openFullDiskAccessSettings() {
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
  );
}

function openAutomationSettings() {
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
  );
}

// Needed by the FaceTime call-state watcher (System Events UI scripting of
// FaceTime.app's window), separate from Automation. Also has no static check.
function openAccessibilitySettings() {
  return shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  );
}

// Best-effort check run at startup; surfaced in the tray/login UI so the
// operator knows exactly which manual step (or MDM profile) is still needed.
function checkPermissions() {
  return {
    fullDiskAccess: canReadChatDb(),
  };
}

// Automation has no static check the way Full Disk Access does -- the only
// way to know is to actually attempt an AppleScript call and see whether it
// comes back as "not authorized" (-1743). Previously that probing only ever
// happened on the first real send, so a missing grant surfaced as a failed
// message instead of a setup step. This asks Messages.app its own name --
// harmless, no side effect -- purely so the status window can show this
// permission the same way it shows Full Disk Access, during setup rather
// than after the first failure. Resolves true/false, or null if the probe
// itself couldn't run for an unrelated reason (so that's never mistaken for
// an actual denial).
function checkAutomationPermission() {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", 'tell application "Messages" to get name'],
      { timeout: 8000 },
      (error, _stdout, stderr) => {
        if (!error) return resolve(true);
        if (/-1743/.test(stderr || "")) return resolve(false);
        resolve(null);
      }
    );
  });
}

module.exports = {
  checkPermissions,
  checkAutomationPermission,
  openFullDiskAccessSettings,
  openAutomationSettings,
  openAccessibilitySettings,
};
