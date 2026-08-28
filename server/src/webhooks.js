const crypto = require("crypto");
const { prisma } = require("./db");

function signPayload(rawBody, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function deliverToCompanyWebhook(companyId, payload) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company || !company.webhookUrl) {
    console.warn(`webhook skipped for company ${companyId}: no webhookUrl configured`);
    return;
  }

  const rawBody = JSON.stringify(payload);
  try {
    const res = await fetch(company.webhookUrl, {
      method: "POST",
      // A signed POST that gets redirected silently loses its body/method
      // under fetch's default redirect-following behavior (a 301/302 turns
      // it into a bodyless GET) -- that's a delivery failure, not something
      // to follow blindly. Treat any redirect response as an explicit error
      // instead.
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-sendnew-signature": signPayload(rawBody, company.webhookSecret),
      },
      body: rawBody,
    });

    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      console.error(
        `webhook delivery for company ${companyId} (event ${payload.event}) was redirected -- ` +
          `fix the stored webhookUrl (${company.webhookUrl}) to point directly at its final destination`
      );
      return;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `webhook delivery for company ${companyId} (event ${payload.event}) rejected: ` +
          `HTTP ${res.status} ${body.slice(0, 500)}`
      );
    }
  } catch (err) {
    console.error(`webhook delivery failed for company ${companyId} (event ${payload.event}):`, err.message);
  }
}

async function deliverInboundToWebhook(companyId, message, conversation, isNewConversation) {
  await deliverToCompanyWebhook(companyId, {
    event: "message.inbound",
    conversationId: conversation.id,
    contactHandle: conversation.contactHandle,
    isNewConversation: !!isNewConversation,
    message: {
      id: message.id,
      kind: message.kind,
      body: message.body,
      mediaUrl: message.mediaUrl,
      createdAt: message.createdAt,
    },
  });
}

// A message sent from another device on the same Apple ID (the user's
// iPhone, or Messages.app used directly on the Mac) -- not triggered by the
// CRM, but the conversation should still reflect it. isNewConversation is
// the same signal as message.inbound carries: this contact handle had never
// been messaged on this device before, so this is likely the first the CRM
// is hearing of it -- worth opening a new conversation tab for.
async function deliverExternalOutboundToWebhook(companyId, message, conversation, isNewConversation) {
  await deliverToCompanyWebhook(companyId, {
    event: "message.sent_from_other_device",
    conversationId: conversation.id,
    contactHandle: conversation.contactHandle,
    isNewConversation: !!isNewConversation,
    message: {
      id: message.id,
      kind: message.kind,
      body: message.body,
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
  deliverExternalOutboundToWebhook,
  deliverFacetimeStatusToWebhook,
  deliverMessageStatusToWebhook,
  signPayload,
};
