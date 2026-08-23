const express = require("express");
const { nanoid } = require("nanoid");
const { prisma } = require("../db");
const { verifyPassword, hashPassword, signDeviceToken } = require("../auth");
const { asyncHandler } = require("../asyncHandler");

const router = express.Router();

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

module.exports = router;
