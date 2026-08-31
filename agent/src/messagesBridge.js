const { execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { shell } = require("electron");
const ffmpegPath = require("ffmpeg-static");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");
const CALL_WATCH_POLL_MS = 1500;
const CALL_WATCH_TIMEOUT_MS = 3 * 60 * 1000; // give up watching after 3 minutes either way
const CALL_WATCH_END_CONFIRM_POLLS = 2; // require 2 consecutive "no window" reads before declaring it over

function runAppleScript(scriptFile, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      [path.join(SCRIPTS_DIR, scriptFile), ...args],
      { timeout: timeoutMs },
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

// mediaUrl from the CRM is a remote URL (something it hosts), not a path on
// this Mac -- Messages.app's AppleScript `send` needs an actual local
// POSIX file, so this downloads it to a temp file first. Returns download
// diagnostics (byte count, actual content-type, what the server claimed) so
// a caller can log/report them -- a mismatch here (e.g. a tiny byte count,
// or a content-type that isn't actually an image) is exactly the kind of
// silent failure that AppleScript's `send` won't itself ever surface as an
// error.
//
// Deliberately does NOT delete the file itself. The caller owns cleanup and
// should only delete the file once chat.db has actually confirmed
// Messages.app created the outgoing row (or definitively given up waiting).
//
// Confirmed via live testing that AppleScript's own `send (POSIX file ...)`
// command hangs indefinitely mid-upload on this machine -- true regardless
// of file format (both PNG and HEIC got stuck the same way) -- while
// manually dragging the identical file into the compose window and hitting
// send delivers instantly. Drag-and-drop and clipboard-paste attach a file
// the same way under the hood, so this drives that path instead of the
// scripting `send` command: bring the right conversation to the front via
// the imessage: URL scheme, put a real file reference on the clipboard (the
// same thing Finder's Cmd-C does), then paste and send via keystrokes (see
// send-imessage-attachment-paste.applescript). Slower and more fragile than
// a single scripting command, but it's the one path that's actually been
// observed to work end-to-end on this Mac.
async function sendIMessageAttachment(to, mediaUrl) {
  const { localPath, diagnostics } = await downloadToTempFile(mediaUrl);
  await shell.openExternal(`imessage:${encodeURIComponent(to)}`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await runAppleScript("send-imessage-attachment-paste.applescript", [to, localPath], 30000);
  return { localPath, diagnostics };
}

// iMessage voice messages are stored as .caf (Apple's Core Audio Format),
// which most browsers besides Safari can't play in an <audio> tag. Converts
// to AAC-in-MP4 (.m4a, MIME type audio/mp4) using a bundled ffmpeg binary
// (ffmpeg-static -- no separate install needed on the Mac mini) so the CRM
// gets something universally playable. Output always goes to a fresh temp
// file; never touches the original attachment, which belongs to
// Messages.app's own store.
function transcodeAudioToM4a(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(
      os.tmpdir(),
      `sendnew-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`
    );
    execFile(
      ffmpegPath,
      ["-y", "-i", inputPath, "-c:a", "aac", "-b:a", "64k", outputPath],
      { timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(outputPath);
      }
    );
  });
}

// iPhones default to capturing photos as HEIC, which most browsers besides
// Safari/WebKit can't render in an <img> tag at all -- confirmed via live
// testing that a real inbound photo showed up as a blank placeholder on the
// CRM's web UI, same failure mode .caf voice messages had before the audio
// transcode above. Converts to JPEG using macOS's built-in `sips` tool (no
// bundled dependency needed, unlike ffmpeg for audio -- sips is Apple's own
// image converter and handles HEIC natively). Output always goes to a fresh
// temp file; never touches the original attachment.
function transcodeHeicToJpeg(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(
      os.tmpdir(),
      `sendnew-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`
    );
    execFile(
      "sips",
      ["-s", "format", "jpeg", inputPath, "--out", outputPath],
      { timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(outputPath);
      }
    );
  });
}

// A tiny/mismatched download can happen even with a 200 OK -- e.g. a CDN or
// auth layer serving an HTML error page or a redirect target instead of the
// real file, none of which fetch() itself treats as a failure. This is
// exactly the class of bug AppleScript's `send` can't detect either, since
// it just hands whatever bytes exist on disk to Messages.app without caring
// what they actually are.
async function downloadToTempFile(url) {
  const res = await fetch(url);
  const contentType = res.headers.get("content-type") || "unknown";
  const declaredLength = res.headers.get("content-length");
  if (!res.ok) throw new Error(`failed to download attachment: HTTP ${res.status} (content-type: ${contentType})`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const diagnostics = {
    url,
    httpStatus: res.status,
    contentType,
    declaredLength: declaredLength ? Number(declaredLength) : null,
    actualBytes: buffer.length,
  };

  if (buffer.length === 0) {
    throw new Error(`downloaded attachment is empty (0 bytes) -- content-type was "${contentType}"`);
  }
  if (contentType.startsWith("text/") || contentType.includes("json")) {
    throw new Error(
      `downloaded attachment looks like an error page, not a file -- content-type was "${contentType}", ${buffer.length} bytes`
    );
  }

  let ext = "";
  try {
    ext = path.extname(new URL(url).pathname);
  } catch {
    // non-URL input (e.g. malformed mediaUrl) -- fall through with no extension
  }
  // Deliberately NOT os.tmpdir() -- that resolves to a per-process, semi-
  // private container under /var/folders/.../T/. Confirmed via live testing
  // that Messages.app hangs forever "loading" an attachment sent from there
  // (0 outbound attachment rows ever appeared in chat.db), while the exact
  // same `send (POSIX file ...)` AppleScript command against an identical
  // file placed on the Desktop delivered instantly end-to-end. Downloads is
  // a plain, ordinary user folder with no special container/sandbox status.
  const outboxDir = path.join(os.homedir(), "Downloads");
  const tempPath = path.join(
    outboxDir,
    `sendnew-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
  );
  fs.writeFileSync(tempPath, buffer);
  return { localPath: tempPath, diagnostics };
}

// Uploads an image attachment chatDbWatcher found in an inbound message to
// the server, which stores it in object storage and delivers it to the CRM
// as a normal message.inbound webhook (mediaUrl populated). Deliberately a
// plain authenticated POST rather than going over the WebSocket, since
// binary uploads don't fit the JSON message protocol used there.
async function uploadInboundAttachment(serverUrl, deviceToken, { contactHandle, externalId, filePath, mimeType }) {
  const buffer = fs.readFileSync(filePath);
  const res = await fetch(`${serverUrl}/agent/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deviceToken}`,
      "content-type": mimeType,
      "x-contact-handle": contactHandle,
      ...(externalId ? { "x-external-id": externalId } : {}),
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`attachment upload failed: HTTP ${res.status} ${text}`);
  }
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

module.exports = {
  sendIMessage,
  sendIMessageAttachment,
  uploadInboundAttachment,
  transcodeAudioToM4a,
  transcodeHeicToJpeg,
  startFaceTime,
  watchFaceTimeCall,
};
