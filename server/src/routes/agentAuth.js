const express = require("express");
const { prisma } = require("../db");
const { verifyPassword, signDeviceToken } = require("../auth");

const router = express.Router();

// Called by the agent app (inside the DMG) on first launch, or whenever it
// needs a fresh token. This is the "user/password prompt" the DMG shows.
router.post("/login", async (req, res) => {
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
});

module.exports = router;
