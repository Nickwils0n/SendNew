const { prisma } = require("./db");

async function deliverInboundToWebhook(companyId, message, conversation) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company || !company.webhookUrl) return;

  const payload = {
    event: "message.inbound",
    conversationId: conversation.id,
    contactHandle: conversation.contactHandle,
    message: {
      id: message.id,
      kind: message.kind,
      body: message.body,
      mediaUrl: message.mediaUrl,
      createdAt: message.createdAt,
    },
  };

  try {
    await fetch(company.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`webhook delivery failed for company ${companyId}:`, err.message);
  }
}

module.exports = { deliverInboundToWebhook };
