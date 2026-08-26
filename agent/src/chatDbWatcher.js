const os = require("os");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const CHAT_DB_PATH = path.join(os.homedir(), "Library", "Messages", "chat.db");
const POLL_INTERVAL_MS = 2000;
const OUTBOUND_POLL_MS = 2000;
// chat.db should show the outgoing row almost instantly if Messages.app
// genuinely accepted the send -- this is deliberately much shorter than the
// delivery-resolution window below.
const CONFIRM_TIMEOUT_MS = 8000;
const RESOLVE_TIMEOUT_MS = 30000;

function openReadOnly() {
  if (!fs.existsSync(CHAT_DB_PATH)) return null;
  // Open read-only so we never risk corrupting Messages.app's live database.
  return new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
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
          `SELECT m.ROWID as rowid, m.guid, m.text, m.is_from_me, m.date,
                  h.id as handle
           FROM message m
           LEFT JOIN handle h ON m.handle_id = h.ROWID
           WHERE m.ROWID > ?
           ORDER BY m.ROWID ASC`
        )
        .all(lastRowId);

      for (const row of rows) {
        lastRowId = Math.max(lastRowId, row.rowid);
        if (!row.text) continue; // skip attachment-only rows for now

        if (row.is_from_me === 0) {
          onInboundMessage({
            externalId: row.guid,
            from: row.handle,
            body: row.text,
            kind: "IMESSAGE",
          });
        } else if (!consumePendingSelfSend(row.handle, row.text)) {
          onExternalOutboundMessage({
            externalId: row.guid,
            to: row.handle,
            body: row.text,
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
function watchOutboundStatus({ contactHandle, body, baselineRowId, fullDiskAccessAvailable }, onEvent) {
  let stopped = false;
  let targetRowId = null;
  let findTimer = null;
  let statusTimer = null;
  const confirmDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
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
      const row = db
        .prepare(
          `SELECT m.ROWID as rowid, m.is_delivered, m.error
           FROM message m
           LEFT JOIN handle h ON m.handle_id = h.ROWID
           WHERE m.ROWID > ? AND m.is_from_me = 1 AND m.text = ? AND h.id = ?
           ORDER BY m.ROWID ASC
           LIMIT 1`
        )
        .get(baselineRowId, body, contactHandle);

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
