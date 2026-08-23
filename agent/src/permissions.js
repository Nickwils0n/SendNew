const fs = require("fs");
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
    // Automation permission can only be confirmed by actually attempting an
    // AppleScript call and catching the "not authorized" error (-1743) —
    // there is no static check. The first send attempt does that probing.
  };
}

module.exports = {
  checkPermissions,
  openFullDiskAccessSettings,
  openAutomationSettings,
  openAccessibilitySettings,
};
