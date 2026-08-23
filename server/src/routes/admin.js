const express = require("express");
const { prisma } = require("../db");
const { hashPassword, requireAdminSecret } = require("../auth");

const router = express.Router();
router.use(requireAdminSecret);

// Create a company (one per CRM tenant on your website).
router.post("/companies", async (req, res) => {
  const { name, webhookUrl } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const company = await prisma.company.create({ data: { name, webhookUrl } });
  res.status(201).json(company);
});

router.get("/companies", async (_req, res) => {
  const companies = await prisma.company.findMany({ orderBy: { createdAt: "desc" } });
  res.json(companies);
});

// Provision credentials for a Mac mini. Give the returned username/password
// to that machine (baked into the DMG build or typed in at first launch).
router.post("/devices", async (req, res) => {
  const { username, password, label, phoneNumber } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const passwordHash = await hashPassword(password);
  const device = await prisma.device.create({
    data: { username, passwordHash, label, phoneNumber },
  });
  res.status(201).json({ id: device.id, username: device.username, label: device.label });
});

router.get("/devices", async (_req, res) => {
  const devices = await prisma.device.findMany({
    orderBy: { createdAt: "desc" },
    include: { company: true },
  });
  res.json(devices);
});

// Assign a provisioned Mac mini to a company so it starts handling that
// company's conversations.
router.post("/devices/:id/assign", async (req, res) => {
  const { companyId } = req.body;
  if (!companyId) return res.status(400).json({ error: "companyId is required" });
  const device = await prisma.device.update({
    where: { id: req.params.id },
    data: { companyId, status: "ASSIGNED" },
  });
  res.json(device);
});

router.post("/devices/:id/unassign", async (req, res) => {
  const device = await prisma.device.update({
    where: { id: req.params.id },
    data: { companyId: null, status: "UNASSIGNED" },
  });
  res.json(device);
});

module.exports = router;
