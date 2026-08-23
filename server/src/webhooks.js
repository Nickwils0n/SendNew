const crypto = require("crypto");
const { prisma } = require("./db");

function signPayload(rawBody, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

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
  const rawBody = JSON.stringify(payload);

  try {
    await fetch(company.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sendnew-signature": signPayload(rawBody, company.webhookSecret),
      },
      body: rawBody,
    });
  } catch (err) {
    console.error(`webhook delivery failed for company ${companyId}:`, err.message);
  }
}

module.exports = { deliverInboundToWebhook, signPayload };
