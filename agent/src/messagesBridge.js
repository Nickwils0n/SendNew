const { execFile } = require("child_process");
const path = require("path");
const { shell } = require("electron");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

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

module.exports = { sendIMessage, sendIMessageAttachment, startFaceTime };
