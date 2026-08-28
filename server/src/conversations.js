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

module.exports = { upsertConversation };
