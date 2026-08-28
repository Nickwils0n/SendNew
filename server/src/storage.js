const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { nanoid } = require("nanoid");

let client = null;

function getClient() {
  if (client) return client;
  const required = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_PUBLIC_URL_BASE"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`image attachments are not configured -- missing env vars: ${missing.join(", ")}`);
  }
  client = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

// Works with any S3-compatible provider (Cloudflare R2, AWS S3, Backblaze B2,
// self-hosted MinIO) via env vars -- see server/.env.example. Returns the
// public URL the CRM's browser can load directly; S3_PUBLIC_URL_BASE must
// point at a bucket/domain that's actually publicly readable (R2's "public
// access" toggle + custom domain, an S3 bucket policy, etc.) -- this module
// doesn't set that up for you, it just uploads.
async function uploadAttachment(buffer, mimeType, deviceId) {
  const ext = mimeType?.split("/")[1]?.split("+")[0] || "bin";
  const key = `attachments/${deviceId}/${Date.now()}-${nanoid(10)}.${ext}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType || "application/octet-stream",
    })
  );

  const base = process.env.S3_PUBLIC_URL_BASE.replace(/\/+$/, "");
  return `${base}/${key}`;
}

module.exports = { uploadAttachment };
