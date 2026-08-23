const express = require("express");
const { nanoid } = require("nanoid");
const { prisma } = require("../db");
const { hashPassword, requireAdminSecret } = require("../auth");
const { asyncHandler } = require("../asyncHandler");

const router = express.Router();
router.use(requireAdminSecret);

// Create a company (one per CRM tenant on your website).
router.post("/companies", asyncHandler(async (req, res) => {
  const { name, webhookUrl } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const company = await prisma.company.create({ data: { name, webhookUrl } });
  res.status(201).json(company);
}));

router.get("/companies", asyncHandler(async (_req, res) => {
  const companies = await prisma.company.findMany({ orderBy: { createdAt: "desc" } });
  res.json(companies);
}));

router.get("/companies/:id", asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({
    where: { id: req.params.id },
    include: { devices: { select: { id: true, label: true, phoneNumber: true, online: true, status: true } } },
  });
  if (!company) return res.status(404).json({ error: "not found" });
  res.json(company);
}));

// Called by your CRM website's backend (never the browser directly — this
// route is admin-secret gated) when a company clicks "regenerate API key" in
// the Send New connections panel.
router.post("/companies/:id/regenerate-key", asyncHandler(async (req, res) => {
  const company = await prisma.company.update({
    where: { id: req.params.id },
    data: { apiKey: `sk_${nanoid(32)}` },
  });
  res.json({ apiKey: company.apiKey });
}));

router.patch("/companies/:id", asyncHandler(async (req, res) => {
  const { webhookUrl, name } = req.body;
  const company = await prisma.company.update({
    where: { id: req.params.id },
    data: {
      ...(webhookUrl !== undefined ? { webhookUrl } : {}),
      ...(name !== undefined ? { name } : {}),
    },
  });
  res.json(company);
}));

// Provision credentials for a Mac mini. Give the returned username/password
// to that machine (baked into the DMG build or typed in at first launch).
router.post("/devices", asyncHandler(async (req, res) => {
  const { username, password, label, phoneNumber } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const passwordHash = await hashPassword(password);
  const device = await prisma.device.create({
    data: { username, passwordHash, label, phoneNumber },
  });
  res.status(201).json({ id: device.id, username: device.username, label: device.label });
}));

router.get("/devices", asyncHandler(async (_req, res) => {
  const devices = await prisma.device.findMany({
    orderBy: { createdAt: "desc" },
    include: { company: true },
  });
  res.json(devices);
}));

// Assign a provisioned Mac mini to a company so it starts handling that
// company's conversations.
router.post("/devices/:id/assign", asyncHandler(async (req, res) => {
  const { companyId } = req.body;
  if (!companyId) return res.status(400).json({ error: "companyId is required" });
  const device = await prisma.device.update({
    where: { id: req.params.id },
    data: { companyId, status: "ASSIGNED" },
  });
  res.json(device);
}));

router.post("/devices/:id/unassign", asyncHandler(async (req, res) => {
  const device = await prisma.device.update({
    where: { id: req.params.id },
    data: { companyId: null, status: "UNASSIGNED" },
  });
  res.json(device);
}));

module.exports = router;
