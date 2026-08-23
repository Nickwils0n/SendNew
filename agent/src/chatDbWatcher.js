const os = require("os");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const CHAT_DB_PATH = path.join(os.homedir(), "Library", "Messages", "chat.db");
const POLL_INTERVAL_MS = 2000;
const OUTBOUND_STATUS_POLL_MS = 2000;
const OUTBOUND_STATUS_TIMEOUT_MS = 30000;

function openReadOnly() {
  if (!fs.existsSync(CHAT_DB_PATH)) return null;
  // Open read-only so we never risk corrupting Messages.app's live database.
  return new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
}

// Reads new inbound messages from the Messages.app database. Requires the
// agent to be granted Full Disk Access (see docs/ARCHITECTURE.md — this is a
// TCC permission a human must grant once, or that an MDM PPPC profile can
// pre-grant for machines you administer).
function watchChatDb(onInboundMessage, onError) {
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
           WHERE m.ROWID > ? AND m.is_from_me = 0
           ORDER BY m.ROWID ASC`
        )
        .all(lastRowId);

      for (const row of rows) {
        lastRowId = Math.max(lastRowId, row.rowid);
        if (!row.text) continue; // skip attachment-only rows for now
        onInboundMessage({
          externalId: row.guid,
          from: row.handle,
          body: row.text,
          kind: "IMESSAGE",
        });
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

// After we tell Messages.app to send something, `send` returning without an
// error only means the AppleScript call succeeded -- not that the message
// was actually delivered. Real delivery/failure status lands asynchronously
// in chat.db (is_delivered / error columns), which this polls for. Finds the
// matching outbound row by contact + text + being newer than baselineRowId
// (captured right before sending), then watches that specific row.
//
// Calls onResolved({ status: "DELIVERED" | "FAILED", errorCode }) once, or
// never at all if it can't find/resolve the row within the timeout -- in
// that case the earlier optimistic SENT status stands, same as before this
// existed. SMS and some iMessage sends legitimately never set is_delivered,
// so "never resolves" is an expected outcome, not a bug.
function watchOutboundStatus({ contactHandle, body, baselineRowId }, onResolved) {
  let stopped = false;
  let targetRowId = null;
  let findTimer = null;
  let statusTimer = null;
  const deadline = Date.now() + OUTBOUND_STATUS_TIMEOUT_MS;

  function findRow() {
    if (stopped) return;
    if (Date.now() > deadline) {
      stop();
      return;
    }
    let db;
    try {
      db = openReadOnly();
      if (!db) {
        findTimer = setTimeout(findRow, OUTBOUND_STATUS_POLL_MS);
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
        checkStatus(row);
      } else {
        findTimer = setTimeout(findRow, OUTBOUND_STATUS_POLL_MS);
      }
    } catch {
      findTimer = setTimeout(findRow, OUTBOUND_STATUS_POLL_MS);
    } finally {
      db?.close();
    }
  }

  function checkStatus(row) {
    if (stopped) return;
    if (row.error && row.error !== 0) {
      onResolved({ status: "FAILED", errorCode: row.error });
      stop();
      return;
    }
    if (row.is_delivered) {
      onResolved({ status: "DELIVERED", errorCode: null });
      stop();
      return;
    }
    if (Date.now() > deadline) {
      stop(); // gave up -- leave the earlier optimistic status as-is
      return;
    }
    statusTimer = setTimeout(pollStatus, OUTBOUND_STATUS_POLL_MS);
  }

  function pollStatus() {
    if (stopped || targetRowId == null) return;
    let db;
    try {
      db = openReadOnly();
      if (!db) {
        statusTimer = setTimeout(pollStatus, OUTBOUND_STATUS_POLL_MS);
        return;
      }
      const row = db.prepare("SELECT is_delivered, error FROM message WHERE ROWID = ?").get(targetRowId);
      if (row) checkStatus({ rowid: targetRowId, ...row });
    } catch {
      statusTimer = setTimeout(pollStatus, OUTBOUND_STATUS_POLL_MS);
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

module.exports = { watchChatDb, getMaxMessageRowId, watchOutboundStatus, CHAT_DB_PATH };
