const { prisma } = require("./db");

// Used for inbound replies, messages sent from another device, and inbound
// attachments -- every path that creates a Message for a contact handle the
// CRM didn't necessarily already know about. Tells the caller whether this
// contact handle has never been seen on this device before, so the CRM can
// decide whether to open a new conversation tab rather than guessing from
// context.
//
// Explicitly updates (rather than leaving untouched) when the conversation
// already exists, purely so Prisma's @updatedAt bumps -- GET /api/conversations
// orders by updatedAt desc and the CRM uses it as a "did anything happen
// here" signal.
async function upsertConversation(deviceId, companyId, contactHandle) {
  const existing = await prisma.conversation.findUnique({
    where: { deviceId_contactHandle: { deviceId, contactHandle } },
  });
  const conversation = existing
    ? await prisma.conversation.update({ where: { id: existing.id }, data: {} })
    : await prisma.conversation.create({ data: { deviceId, companyId, contactHandle } });
  return { conversation, isNewConversation: !existing };
}

// How many new contacts this device has started talking to today (UTC day
// boundary -- simplest option until a company/device timezone is asked for).
// Conversation has @@unique([deviceId, contactHandle]), so a row is created
// exactly once per device-contact pair: counting rows created today IS the
// day's new-contact count, no separate usage table needed.
async function newContactsToday(deviceId) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  return prisma.conversation.count({
    where: { deviceId, createdAt: { gte: startOfDay } },
  });
}

// A device's own override wins; otherwise fall back to its company's
// default; null means uncapped.
function capFor(device, company) {
  if (device.dailyCapOverride != null) return device.dailyCapOverride;
  return (company && company.defaultDailyCap) ?? null;
}

// Which device a new outbound message to `contactHandle` should go out
// through, for load-balancing new-contact volume across the fleet so no
// single number gets flagged for messaging too many new people too fast.
//
// An existing conversation is always sticky to the device it started on --
// switching numbers mid-conversation looks suspicious to the recipient and
// splits history across two Macs' own chat.db. Only a genuinely new contact
// (no Conversation row yet under this company) goes through the
// least-loaded-under-cap selection below.
async function pickDeviceForContact(company, contactHandle, isDeviceOnline) {
  const existing = await prisma.conversation.findFirst({
    where: { companyId: company.id, contactHandle },
    include: { device: true },
  });
  if (existing) return { device: existing.device };

  const candidates = await prisma.device.findMany({
    where: { companyId: company.id, status: "ASSIGNED" },
  });
  const online = candidates.filter((d) => isDeviceOnline(d.id));
  if (!online.length) return { held: true, anyOnline: false };

  const withLoad = await Promise.all(
    online.map(async (device) => ({
      device,
      cap: capFor(device, company),
      count: await newContactsToday(device.id),
    }))
  );
  const eligible = withLoad.filter((d) => d.cap == null || d.count < d.cap);
  if (!eligible.length) return { held: true, anyOnline: true };

  eligible.sort((a, b) => a.count - b.count);
  return { device: eligible[0].device };
}

module.exports = { upsertConversation, newContactsToday, capFor, pickDeviceForContact };
