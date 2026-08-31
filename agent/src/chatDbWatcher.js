const os = require("os");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const CHAT_DB_PATH = path.join(os.homedir(), "Library", "Messages", "chat.db");
const POLL_INTERVAL_MS = 2000;
const OUTBOUND_POLL_MS = 2000;
// chat.db should show the outgoing row almost instantly if Messages.app
// genuinely accepted the send -- this is deliberately much shorter than the
// delivery-resolution window below. Attachments get longer: Messages.app has
// to actually copy the file into its own Attachments folder and register it
// before the row exists, which is measurably slower than just writing text.
const CONFIRM_TIMEOUT_MS = 8000;
const CONFIRM_TIMEOUT_ATTACHMENT_MS = 20000;
// A message body containing a URL triggers Messages.app's rich link-preview
// data detector (fetching the page's Open Graph metadata/thumbnail before
// finalizing the send) -- confirmed via live testing that this routinely
// pushes row creation past the plain-text confirm window, falsely reporting
// FAILED on messages that actually delivered fine. Give those the same
// longer allowance as attachments.
const CONFIRM_TIMEOUT_LINK_MS = 20000;
const URL_PATTERN = /https?:\/\/\S+/i;
// Confirmed via live testing (checking chat.db well after the fact) that
// Apple's delivery receipt round-trip -- recipient device -> Apple's
// servers -> back to this Mac's chat.db -- can genuinely take longer than
// 30s even for a message the recipient visibly received right away. Once
// this window closes without seeing is_delivered flip, we stop watching for
// good and the message is stuck showing SENT forever even though it was
// truly delivered. Polling already stops the instant it resolves either
// way, so widening this only delays how long a message that *never* gets a
// receipt (SMS, or some iMessage sends) sits "pending" before we give up.
const RESOLVE_TIMEOUT_MS = 120000;

function openReadOnly() {
  if (!fs.existsSync(CHAT_DB_PATH)) return null;
  // Open read-only so we never risk corrupting Messages.app's live database.
  return new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
}

// On newer macOS versions, chat.db's plain `message.text` column is often
// empty even for a normal text message -- the actual content instead lives
// in `attributedBody`, a binary NSKeyedArchiver-serialized NSAttributedString
// blob. Apple doesn't document this format; the byte pattern below (an
// "NSString" marker followed by a fixed 5-byte type marker, then a length
// prefix and the UTF-8 text) is reverse-engineered but a stable, widely-used
// pattern across other chat.db tooling.
//
// A message containing a URL gets extra structure in this blob beyond a
// plain string -- Messages' link-detection attaches an attribute run (and
// likely a duplicate NSURL/NSString for the detected link) around the
// message text, which can put an earlier "NSString"-tagged object in the
// buffer that isn't immediately followed by our expected type marker.
// Confirmed via live testing that bailing out on the first mismatch (the
// original behavior here) returns null for exactly these messages -- the
// real text's marker is simply further into the buffer. Keep scanning
// subsequent occurrences instead of giving up on the first one.
const ATTRIBUTED_BODY_TYPE_MARKER = Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]);

function extractAttributedBodyText(buffer) {
  if (!buffer || buffer.length === 0) return null;

  let searchFrom = 0;
  while (true) {
    const markerIndex = buffer.indexOf("NSString", searchFrom, "latin1");
    if (markerIndex === -1) return null;

    const cursor = markerIndex + "NSString".length;
    if (buffer.subarray(cursor, cursor + ATTRIBUTED_BODY_TYPE_MARKER.length).equals(ATTRIBUTED_BODY_TYPE_MARKER)) {
      let textCursor = cursor + ATTRIBUTED_BODY_TYPE_MARKER.length;
      let length;
      if (buffer[textCursor] === 0x81) {
        length = buffer.readUInt16LE(textCursor + 1);
        textCursor += 3;
      } else {
        length = buffer[textCursor];
        textCursor += 1;
      }

      if (Number.isFinite(length) && length > 0 && textCursor + length <= buffer.length) {
        return buffer.subarray(textCursor, textCursor + length).toString("utf8");
      }
    }

    searchFrom = markerIndex + "NSString".length;
  }
}

// Prefers the plain text column, falling back to attributedBody extraction
// when it's empty -- covers both message forms without callers needing to
// know which one a given row used.
function readMessageText(row) {
  if (row.text) return row.text;
  return extractAttributedBodyText(row.attributedBody);
}

// With "Messages in iCloud" enabled, a message sent from any of the user's
// own devices (an iPhone, or someone typing directly into Messages.app on
// this Mac) syncs into this same chat.db as a normal outbound row -- not
// just messages this agent itself sent through the CRM. To tell those apart
// from our own CRM-triggered sends without needing a hard row-ID handoff
// between the two watchers, main.js registers a short-lived fingerprint
// right before it asks Messages.app to send something; anything matching
// gets treated as "ours" and consumed silently (watchOutboundStatus already
// reports on it separately). Anything that shows up unregistered came from
// somewhere else and gets reported as such.
const PENDING_SELF_SEND_TTL_MS = 15000;
const pendingSelfSends = new Map(); // `${contact}|${body}` -> expiresAt

function registerPendingSelfSend(contactHandle, body) {
  pendingSelfSends.set(`${contactHandle}|${body}`, Date.now() + PENDING_SELF_SEND_TTL_MS);
}

function consumePendingSelfSend(contactHandle, body) {
  const key = `${contactHandle}|${body}`;
  const expiresAt = pendingSelfSends.get(key);
  if (expiresAt === undefined) return false;
  pendingSelfSends.delete(key);
  return expiresAt >= Date.now();
}

// Attachment rows have no `text`; the actual file lives at a local path
// recorded in chat.db's own attachment table. Only image and audio
// attachments are handled right now -- other types (video, vCards, etc.) are
// silently skipped, a documented gap rather than an oversight. Voice
// messages arrive here as an audio attachment like any other -- chat.db's
// own audio-message flag isn't needed since we treat any audio/* the same
// way regardless of whether it was a tap-to-record bubble or a dragged-in
// audio file.
//
// A Live Photo is really two joined attachments on the same message -- a
// still HEIC image plus a companion .mov motion clip. Ordering by ROWID
// alone could land on the video half first, which isn't image/* or audio/*
// and would silently skip the whole message as an unsupported type (this is
// why Live Photos weren't coming through at all). Explicitly prefer an
// image/* attachment when one exists, so a Live Photo comes through as its
// still-photo component instead of being dropped.
function getMediaAttachment(db, messageRowId) {
  const row = db
    .prepare(
      `SELECT a.filename, a.mime_type
       FROM message_attachment_join maj
       JOIN attachment a ON maj.attachment_id = a.ROWID
       WHERE maj.message_id = ?
       ORDER BY (CASE WHEN a.mime_type LIKE 'image/%' THEN 0 ELSE 1 END), a.ROWID ASC
       LIMIT 1`
    )
    .get(messageRowId);
  if (!row?.filename || !row.mime_type) return null;

  const isImage = row.mime_type.startsWith("image/");
  const isAudio = row.mime_type.startsWith("audio/");
  if (!isImage && !isAudio) return null;

  const filePath = row.filename.startsWith("~")
    ? path.join(os.homedir(), row.filename.slice(1))
    : row.filename;
  return { filePath, mimeType: row.mime_type, isAudio };
}

// Watches chat.db for both inbound replies and outbound messages sent from
// somewhere other than this agent (see above). Requires the agent to be
// granted Full Disk Access (see docs/ARCHITECTURE.md — a TCC permission a
// human must grant once, or that an MDM PPPC profile can pre-grant).
function watchChatDb(onInboundMessage, onExternalOutboundMessage, onError) {
  let lastRowId = 0;
  let timer = null;

  function poll() {
    let db;
    try {
      db = openReadOnly();
      if (!db) return;

      if (lastRowId === 0) {
        const row = db.prepare("SELECT MAX(ROWID) as maxId FROM message").get();
        lastRowId = row?.maxId || 0;
        return; // seed baseline only, don't replay history on first run
      }

      const rows = db
        .prepare(
          `SELECT m.ROWID as rowid, m.guid, m.text, m.attributedBody, m.is_from_me, m.date,
                  h.id as handle
           FROM message m
           LEFT JOIN handle h ON m.handle_id = h.ROWID
           WHERE m.ROWID > ?
           ORDER BY m.ROWID ASC`
        )
        .all(lastRowId);

      for (const row of rows) {
        lastRowId = Math.max(lastRowId, row.rowid);
        const text = readMessageText(row);

        if (row.is_from_me === 0) {
          // Check for an attachment before falling back to text -- an
          // attachment-only row carries the same placeholder character
          // (e.g. U+FFFC) in `text`/attributedBody as an outbound attachment
          // row does (see the outbound branch below), not real content.
          // Checking `text` first would misreport every inbound image/audio
          // message as a blank/placeholder text message and never look at
          // the actual attachment.
          const attachment = getMediaAttachment(db, row.rowid);
          if (attachment) {
            onInboundMessage({
              externalId: row.guid,
              from: row.handle,
              body: null,
              kind: "IMESSAGE",
              attachment,
            });
          } else if (text) {
            onInboundMessage({ externalId: row.guid, from: row.handle, body: text, kind: "IMESSAGE" });
          }
          // unsupported attachment type (or no attachment, no text) -- nothing usable to report yet
        } else if (getMediaAttachment(db, row.rowid)) {
          // Attachment-only rows carry a placeholder character (e.g. U+FFFC)
          // in `text`/attributedBody, not real content -- reporting that as
          // if it were a typed message would misrepresent both our own
          // attachment sends (already handled separately by
          // watchOutboundStatus's matchAttachment mode) and attachments sent
          // from another device, which aren't relayed yet at all (documented
          // gap -- only text is handled on this path so far).
        } else if (text && !consumePendingSelfSend(row.handle, text)) {
          onExternalOutboundMessage({
            externalId: row.guid,
            to: row.handle,
            body: text,
            kind: "IMESSAGE",
          });
        }
      }
    } catch (err) {
      onError?.(err);
    } finally {
      db?.close();
    }
  }

  poll(); // seed baseline
  timer = setInterval(poll, POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}

// Returns 0 (rather than throwing) if chat.db can't be opened -- typically
// means Full Disk Access isn't actually granted, even if the file exists on
// disk (fs.existsSync can return true while SQLite still gets SQLITE_CANTOPEN
// from TCC). Callers treat 0 as "outbound delivery-status watching isn't
// available right now," not as a reason to fail the send itself.
function getMaxMessageRowId() {
  let db;
  try {
    db = openReadOnly();
    if (!db) return 0;
    return db.prepare("SELECT MAX(ROWID) as maxId FROM message").get()?.maxId || 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

// A successful AppleScript `send` call only means Messages.app accepted the
// request -- it does not mean anything was actually sent. This watches
// chat.db for real confirmation in two stages and reports each via onEvent:
//
//   { type: "confirmed" }
//     The outgoing row actually appeared in chat.db -- Messages.app truly
//     created it. This is what "SENT" should mean, not "the command didn't
//     throw." Fires almost immediately for a genuine send.
//
//   { type: "not_confirmed" }
//     The row never appeared within CONFIRM_TIMEOUT_MS, and chat.db access
//     itself is known to be working (fullDiskAccessAvailable) -- so the
//     absence is a real signal, not a permissions gap. Treat as a failed
//     send.
//
//   (nothing fires, ever)
//     Either fullDiskAccessAvailable was false (we genuinely can't verify
//     either way -- don't guess, leave the message at whatever status it
//     already had), or the row was found and delivery/error never resolved
//     within RESOLVE_TIMEOUT_MS (expected for SMS and some iMessage sends,
//     which never get a delivery receipt at all).
//
//   { type: "resolved", status: "DELIVERED" | "FAILED", errorCode }
//     Apple's own delivery/error columns resolved after confirmation.
//
// `matchAttachment: true` looks for the newest outbound row from this
// contact that has an attachment at all, instead of matching on `body` text
// (attachment rows have no text) -- used for image/audio sends instead of
// the text-matching path.
function watchOutboundStatus(
  { contactHandle, body, baselineRowId, fullDiskAccessAvailable, matchAttachment },
  onEvent
) {
  let stopped = false;
  let targetRowId = null;
  let findTimer = null;
  let statusTimer = null;
  const confirmTimeoutMs = matchAttachment
    ? CONFIRM_TIMEOUT_ATTACHMENT_MS
    : URL_PATTERN.test(body || "")
    ? CONFIRM_TIMEOUT_LINK_MS
    : CONFIRM_TIMEOUT_MS;
  const confirmDeadline = Date.now() + confirmTimeoutMs;
  const resolveDeadline = Date.now() + RESOLVE_TIMEOUT_MS;

  function findRow() {
    if (stopped) return;
    if (Date.now() > confirmDeadline) {
      if (fullDiskAccessAvailable) onEvent({ type: "not_confirmed" });
      stop();
      return;
    }
    let db;
    try {
      db = openReadOnly();
      if (!db) {
        findTimer = setTimeout(findRow, OUTBOUND_POLL_MS);
        return;
      }
      let row;
      if (matchAttachment) {
        row = db
          .prepare(
            `SELECT m.ROWID as rowid, m.is_delivered, m.error
             FROM message m
             LEFT JOIN handle h ON m.handle_id = h.ROWID
             WHERE m.ROWID > ? AND m.is_from_me = 1 AND h.id = ?
               AND EXISTS (SELECT 1 FROM message_attachment_join maj WHERE maj.message_id = m.ROWID)
             ORDER BY m.ROWID ASC
             LIMIT 1`
          )
          .get(baselineRowId, contactHandle);
      } else {
        // Can't filter by text in SQL -- on newer macOS versions the plain
        // `text` column is often empty and the real content only exists in
        // attributedBody, which needs JS-side extraction (see
        // readMessageText). Candidate rows are few (right after our own
        // send), so scanning them in JS is cheap.
        const candidates = db
          .prepare(
            `SELECT m.ROWID as rowid, m.text, m.attributedBody, m.is_delivered, m.error
             FROM message m
             LEFT JOIN handle h ON m.handle_id = h.ROWID
             WHERE m.ROWID > ? AND m.is_from_me = 1 AND h.id = ?
             ORDER BY m.ROWID ASC`
          )
          .all(baselineRowId, contactHandle);
        row = candidates.find((candidate) => readMessageText(candidate) === body);
      }

      if (row) {
        targetRowId = row.rowid;
        onEvent({ type: "confirmed" });
        checkStatus(row);
      } else {
        findTimer = setTimeout(findRow, OUTBOUND_POLL_MS);
      }
    } catch {
      findTimer = setTimeout(findRow, OUTBOUND_POLL_MS);
    } finally {
      db?.close();
    }
  }

  function checkStatus(row) {
    if (stopped) return;
    if (row.error && row.error !== 0) {
      onEvent({ type: "resolved", status: "FAILED", errorCode: row.error });
      stop();
      return;
    }
    if (row.is_delivered) {
      onEvent({ type: "resolved", status: "DELIVERED", errorCode: null });
      stop();
      return;
    }
    if (Date.now() > resolveDeadline) {
      stop(); // gave up -- no further correction, confirmed SENT stands
      return;
    }
    statusTimer = setTimeout(pollStatus, OUTBOUND_POLL_MS);
  }

  function pollStatus() {
    if (stopped || targetRowId == null) return;
    let db;
    try {
      db = openReadOnly();
      if (!db) {
        statusTimer = setTimeout(pollStatus, OUTBOUND_POLL_MS);
        return;
      }
      const row = db.prepare("SELECT is_delivered, error FROM message WHERE ROWID = ?").get(targetRowId);
      if (row) checkStatus({ rowid: targetRowId, ...row });
    } catch {
      statusTimer = setTimeout(pollStatus, OUTBOUND_POLL_MS);
    } finally {
      db?.close();
    }
  }

  function stop() {
    stopped = true;
    clearTimeout(findTimer);
    clearTimeout(statusTimer);
  }

  findRow();
  return stop;
}

module.exports = {
  watchChatDb,
  getMaxMessageRowId,
  watchOutboundStatus,
  registerPendingSelfSend,
  CHAT_DB_PATH,
};
