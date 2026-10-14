const express = require("express");
const { nanoid } = require("nanoid");
const { prisma } = require("../db");
const { hashPassword, requireAdminSecret } = require("../auth");
const { asyncHandler } = require("../asyncHandler");
const { newContactsToday, capFor } = require("../conversations");
const { RACK_BAYS, SWITCH_PORTS } = require("../rackConfig");

const router = express.Router();
router.use(requireAdminSecret);

// Never hand back passwordHash. Every /admin/devices* response goes through
// this, including the ones that also include the related company.
function deviceOut(device) {
  const { passwordHash, ...rest } = device;
  return rest;
}

const intOrNull = (v, lo, hi) => {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN;
};

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
  const { webhookUrl, name, defaultDailyCap } = req.body;
  const data = {
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    ...(name !== undefined ? { name } : {}),
  };
  if (defaultDailyCap !== undefined) {
    const cap = intOrNull(defaultDailyCap, 0, 100000);
    if (Number.isNaN(cap)) return res.status(400).json({ error: "defaultDailyCap is a whole number" });
    data.defaultDailyCap = cap;
  }
  const company = await prisma.company.update({ where: { id: req.params.id }, data });
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
  res.json(devices.map(deviceOut));
}));

// Single device, for the rack console's zoomed-in panel.
router.get("/devices/:id", asyncHandler(async (req, res) => {
  const device = await prisma.device.findUnique({ where: { id: req.params.id }, include: { company: true } });
  if (!device) return res.status(404).json({ error: "not found" });
  res.json(deviceOut(device));
}));

// General field edits. rackSlot/switchPort are unique, so a taken bay or
// port comes back as 409 rather than a generic 500.
router.patch("/devices/:id", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (b.label !== undefined) data.label = b.label || null;
  if (b.phoneNumber !== undefined) data.phoneNumber = b.phoneNumber || null;
  if (b.rackSlot !== undefined) data.rackSlot = intOrNull(b.rackSlot, 1, RACK_BAYS);
  if (b.switchPort !== undefined) data.switchPort = intOrNull(b.switchPort, 1, SWITCH_PORTS);
  if (b.dailyCapOverride !== undefined) data.dailyCapOverride = intOrNull(b.dailyCapOverride, 0, 100000);
  if ([data.rackSlot, data.switchPort, data.dailyCapOverride].some((v) => Number.isNaN(v))) {
    return res.status(400).json({ error: `rackSlot is 1-${RACK_BAYS}, switchPort is 1-${SWITCH_PORTS}, dailyCapOverride is a whole number` });
  }
  try {
    const device = await prisma.device.update({ where: { id: req.params.id }, data, include: { company: true } });
    res.json(deviceOut(device));
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "that bay or switch port is already taken" });
    if (err.code === "P2025") return res.status(404).json({ error: "not found" });
    throw err;
  }
}));

// Newest DeviceLog rows first, for the panel's activity feed. ?limit (max
// 200) and ?before=<ISO> to page back.
router.get("/devices/:id/logs", asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  const logs = await prisma.deviceLog.findMany({
    where: { deviceId: req.params.id, ...(before && !isNaN(before) ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  res.json(logs);
}));

// Load vs cap for today (midnight UTC), derived from Conversation.createdAt
// -- see newContactsToday()/capFor() in conversations.js.
router.get("/devices/:id/usage-today", asyncHandler(async (req, res) => {
  const device = await prisma.device.findUnique({ where: { id: req.params.id }, include: { company: true } });
  if (!device) return res.status(404).json({ error: "not found" });
  res.json({ newContactsToday: await newContactsToday(device.id), cap: capFor(device, device.company) });
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
  res.json(deviceOut(device));
}));

router.post("/devices/:id/unassign", asyncHandler(async (req, res) => {
  const device = await prisma.device.update({
    where: { id: req.params.id },
    data: { companyId: null, status: "UNASSIGNED" },
  });
  res.json(deviceOut(device));
}));

// Passwords are stored hashed and can't be recovered -- use this when a
// Mac mini's credentials are lost (e.g. never saved after provisioning).
// Generates and returns a fresh password for the device's *existing*
// username, leaving its company assignment/phoneNumber/label untouched --
// log back in via the agent's login window with the username it already
// has and this new password.
router.post("/devices/:id/reset-password", asyncHandler(async (req, res) => {
  const password = nanoid(20);
  const passwordHash = await hashPassword(password);
  const device = await prisma.device.update({
    where: { id: req.params.id },
    data: { passwordHash },
  });
  res.json({ id: device.id, username: device.username, password });
}));

module.exports = router;
