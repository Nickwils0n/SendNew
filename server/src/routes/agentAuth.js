const express = require("express");
const { nanoid } = require("nanoid");
const { prisma } = require("../db");
const { verifyPassword, hashPassword, signDeviceToken, verifyDeviceToken } = require("../auth");
const { asyncHandler } = require("../asyncHandler");
const { RACK_BAYS, SWITCH_PORTS } = require("../rackConfig");

const router = express.Router();

const intOrNull = (v, lo, hi) => {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN;
};

function deviceFromBearer(req) {
  const authHeader = req.header("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return { error: 401, body: { error: "missing bearer token" } };
  try {
    return { deviceId: verifyDeviceToken(token).sub };
  } catch {
    return { error: 401, body: { error: "invalid token" } };
  }
}

// Called by the agent app (inside the DMG) on first launch, or whenever it
// needs a fresh token. This is the "user/password prompt" the DMG shows.
router.post("/login", asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const device = await prisma.device.findUnique({ where: { username } });
  if (!device) return res.status(401).json({ error: "invalid credentials" });

  const ok = await verifyPassword(password, device.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });

  const token = signDeviceToken(device);
  res.json({
    token,
    device: {
      id: device.id,
      username: device.username,
      label: device.label,
      companyId: device.companyId,
      status: device.status,
    },
  });
}));

// Called from the DMG's "Register this device" flow (see login.html) so a
// new Mac mini can provision itself without you manually running curl
// against /admin/devices every time. Gated by DEVICE_SETUP_CODE — a single
// shared code you hand to whoever is setting up new machines, distinct from
// ADMIN_SECRET (which grants full company/device management, not just "make
// one new device row"). Set DEVICE_SETUP_CODE on the server to enable this;
// leaving it unset disables self-registration entirely.
router.post("/register", asyncHandler(async (req, res) => {
  const { setupCode, label } = req.body;
  if (!process.env.DEVICE_SETUP_CODE) {
    return res.status(503).json({ error: "device self-registration is not enabled on this server" });
  }
  if (!setupCode || setupCode !== process.env.DEVICE_SETUP_CODE) {
    return res.status(401).json({ error: "invalid setup code" });
  }

  const username = `device-${nanoid(10)}`;
  const password = nanoid(24);
  const passwordHash = await hashPassword(password);
  const device = await prisma.device.create({
    data: { username, passwordHash, label: label || null },
  });

  const token = signDeviceToken(device);
  res.status(201).json({
    token,
    // Shown once so the operator can note it down for reference — not
    // required for normal operation, since the app stores its own token.
    credentials: { username, password },
    device: {
      id: device.id,
      username: device.username,
      label: device.label,
      companyId: device.companyId,
      status: device.status,
    },
  });
}));

// The agent's own "did setup work" check -- polled by the status window so
// an operator sees company assignment and rack placement update live,
// right inside the app, without tabbing over to the CRM's Rack page.
function deviceOut(device) {
  return {
    id: device.id,
    username: device.username,
    label: device.label,
    status: device.status,
    companyId: device.companyId,
    companyName: device.company ? device.company.name : null,
    rackSlot: device.rackSlot,
    switchPort: device.switchPort,
  };
}

router.get("/me", asyncHandler(async (req, res) => {
  const auth = deviceFromBearer(req);
  if (auth.error) return res.status(auth.error).json(auth.body);

  const device = await prisma.device.findUnique({ where: { id: auth.deviceId }, include: { company: true } });
  if (!device) return res.status(401).json({ error: "unknown device" });

  res.json(deviceOut(device));
}));

// Lets a device set where it physically sits -- rackSlot/switchPort only.
// The operator standing at the Mac mini knows which bay/port it just went
// into, so they shouldn't have to switch to the CRM's Rack page just for
// that. Deliberately narrow: this is pure inventory metadata with no
// security weight, unlike company assignment, caps, or anything else,
// which stay admin-secret-gated on PATCH /admin/devices/:id.
router.patch("/me", asyncHandler(async (req, res) => {
  const auth = deviceFromBearer(req);
  if (auth.error) return res.status(auth.error).json(auth.body);

  const b = req.body || {};
  const data = {};
  if (b.rackSlot !== undefined) data.rackSlot = intOrNull(b.rackSlot, 1, RACK_BAYS);
  if (b.switchPort !== undefined) data.switchPort = intOrNull(b.switchPort, 1, SWITCH_PORTS);
  if ([data.rackSlot, data.switchPort].some((v) => Number.isNaN(v))) {
    return res.status(400).json({ error: `rackSlot is 1-${RACK_BAYS}, switchPort is 1-${SWITCH_PORTS}` });
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: "nothing to change" });

  try {
    const device = await prisma.device.update({ where: { id: auth.deviceId }, data, include: { company: true } });
    res.json(deviceOut(device));
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "that bay or switch port is already taken" });
    if (err.code === "P2025") return res.status(401).json({ error: "unknown device" });
    throw err;
  }
}));

module.exports = router;
