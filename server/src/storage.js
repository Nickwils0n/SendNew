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
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || path.join(__dirname, "..", "data", "attachments");

async function uploadAttachment(buffer, mimeType) {
  if (!process.env.PUBLIC_URL_BASE) {
    throw new Error("image attachments are not configured -- PUBLIC_URL_BASE env var is missing");
  }

  const ext = mimeType?.split("/")[1]?.split("+")[0] || "bin";
  // Unguessable filename doubles as the only access control on the serving
  // route below -- there's no per-request auth on it, so this is what keeps
  // these URLs from being enumerable.
  const filename = `${Date.now()}-${nanoid(24)}.${ext}`;

  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
  await fs.writeFile(path.join(ATTACHMENTS_DIR, filename), buffer);

  const base = process.env.PUBLIC_URL_BASE.replace(/\/+$/, "");
  return `${base}/media/${filename}`;
}

module.exports = { uploadAttachment, ATTACHMENTS_DIR };
