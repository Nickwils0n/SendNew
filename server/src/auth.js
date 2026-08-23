const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { prisma } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET env var is required");
}

const DEVICE_TOKEN_TTL = "30d";

function signDeviceToken(device) {
  return jwt.sign({ sub: device.id, type: "device" }, JWT_SECRET, {
    expiresIn: DEVICE_TOKEN_TTL,
  });
}

function verifyDeviceToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.type !== "device") throw new Error("invalid token type");
  return payload;
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Express middleware: authenticate the existing CRM website via company API key.
async function requireCompanyApiKey(req, res, next) {
  try {
    const apiKey = req.header("x-api-key");
    if (!apiKey) return res.status(401).json({ error: "missing x-api-key header" });
    const company = await prisma.company.findUnique({ where: { apiKey } });
    if (!company) return res.status(401).json({ error: "invalid api key" });
    req.company = company;
    next();
  } catch (err) {
    next(err);
  }
}

// Express middleware: authenticate an admin operation (you, provisioning devices/companies).
function requireAdminSecret(req, res, next) {
  const secret = req.header("x-admin-secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

module.exports = {
  signDeviceToken,
  verifyDeviceToken,
  hashPassword,
  verifyPassword,
  requireCompanyApiKey,
  requireAdminSecret,
};
