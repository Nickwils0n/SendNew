const crypto = require("crypto");
const { prisma } = require("./db");

function signPayload(rawBody, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function deliverToCompanyWebhook(companyId, payload) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company || !company.webhookUrl) return;

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

async function deliverInboundToWebhook(companyId, message, conversation) {
  await deliverToCompanyWebhook(companyId, {
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
  });
}

// Best-effort, undocumented FaceTime window-state signal (see
// agent/src/messagesBridge.js) — `raw` is whatever text the agent observed
// in FaceTime's window title, unvalidated against real call states. Treat
// this event as informational, not a reliable "answered"/"ended" indicator.
async function deliverFacetimeStatusToWebhook(companyId, message, raw, error) {
  await deliverToCompanyWebhook(companyId, {
    event: "facetime.status",
    messageId: message.id,
    conversationId: message.conversationId,
    kind: message.kind,
    raw: raw || null,
    error: error || null,
    observedAt: new Date().toISOString(),
  });
}

// Fires every time an outbound message's status changes -- the initial
// optimistic SENT (AppleScript call succeeded, not proof of delivery) and,
// if the agent's chat.db watcher resolves it, a later corrected DELIVERED
// or FAILED. Without this, the CRM has no way to learn about a status change
// after its initial 202 response.
async function deliverMessageStatusToWebhook(companyId, message) {
  await deliverToCompanyWebhook(companyId, {
    event: "message.status",
    messageId: message.id,
    conversationId: message.conversationId,
    kind: message.kind,
    status: message.status,
    error: message.error || null,
    updatedAt: message.updatedAt,
  });
}

module.exports = {
  deliverInboundToWebhook,
  deliverFacetimeStatusToWebhook,
  deliverMessageStatusToWebhook,
  signPayload,
};
