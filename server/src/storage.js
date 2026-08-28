const fs = require("fs/promises");
const path = require("path");
const { nanoid } = require("nanoid");

// Backed by a Railway Volume mounted at ATTACHMENTS_DIR -- persists across
// deploys/restarts of this service. Railway volumes have no built-in public
// URL, so routes/media.js serves these files back out over plain HTTP;
// PUBLIC_URL_BASE is this server's own public URL, used to build the
// mediaUrl handed to the CRM. Only safe with a single server instance/replica
// -- a volume isn't shared across horizontally scaled replicas, which isn't
// a concern at this project's current scale but would be if that changes.
// Railway's env var UI stores whatever string is entered verbatim, quote
// characters included -- pasting a value straight from .env.example's
// ATTACHMENTS_DIR="/data/attachments" (dotenv/shell syntax, where the quotes
// are just delimiters) leaves the actual value as the 11-characters-longer
// string "/data/attachments" (quotes and all). That string isn't absolute as
// far as Node's `path` module is concerned, so every write silently landed
// somewhere under this container's ephemeral working directory instead of
// the real Volume mount -- surviving until the next restart/redeploy, but
// never actually persisted, and unreadable by res.sendFile in media.js
// (which requires a genuinely absolute path and throws instead of silently
// misbehaving). Stripping a matching pair of leading/trailing quotes here
// makes both a raw value and an accidentally-quoted one work the same way.
function stripQuotes(value) {
  if (!value) return value;
  const match = value.match(/^(["'])(.*)\1$/);
  return match ? match[2] : value;
}

const ATTACHMENTS_DIR = stripQuotes(process.env.ATTACHMENTS_DIR) || path.join(__dirname, "..", "data", "attachments");

async function uploadAttachment(buffer, mimeType) {
  const publicUrlBase = stripQuotes(process.env.PUBLIC_URL_BASE);
  if (!publicUrlBase) {
    throw new Error("image attachments are not configured -- PUBLIC_URL_BASE env var is missing");
  }
  if (!path.isAbsolute(ATTACHMENTS_DIR)) {
    throw new Error(`ATTACHMENTS_DIR must be an absolute path, got: ${ATTACHMENTS_DIR}`);
  }

  const ext = mimeType?.split("/")[1]?.split("+")[0] || "bin";
  // Unguessable filename doubles as the only access control on the serving
  // route below -- there's no per-request auth on it, so this is what keeps
  // these URLs from being enumerable.
  const filename = `${Date.now()}-${nanoid(24)}.${ext}`;

  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
  await fs.writeFile(path.join(ATTACHMENTS_DIR, filename), buffer);

  const base = publicUrlBase.replace(/\/+$/, "");
  return `${base}/media/${filename}`;
}

module.exports = { uploadAttachment, ATTACHMENTS_DIR };
