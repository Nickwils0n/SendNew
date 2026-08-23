const os = require("os");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const CHAT_DB_PATH = path.join(os.homedir(), "Library", "Messages", "chat.db");
const POLL_INTERVAL_MS = 2000;

// Reads new inbound messages from the Messages.app database. Requires the
// agent to be granted Full Disk Access (see docs/ARCHITECTURE.md — this is a
// TCC permission a human must grant once, or that an MDM PPPC profile can
// pre-grant for machines you administer).
function watchChatDb(onInboundMessage, onError) {
  let lastRowId = 0;
  let timer = null;

  function readDb() {
    if (!fs.existsSync(CHAT_DB_PATH)) return null;
    // Open read-only so we never risk corrupting Messages.app's live database.
    return new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
  }

  function poll() {
    let db;
    try {
      db = readDb();
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

module.exports = { watchChatDb, CHAT_DB_PATH };
