// ── Website bot — HighLevel Custom Conversation Provider delivery webhook ────
// This is the "Delivery URL" configured on the Marketplace App's Conversation
// Provider (Settings > Conversation Provider > Delivery URL). HighLevel calls
// this when a staff member replies to a contact from within HighLevel's
// Conversations UI on this custom channel ("ProviderOutboundMessage"), so we
// can relay that reply back into the visitor's live website chat.
//
// STUB — awaiting the app's conversationProviderId + OAuth client id/secret
// before the real logic (verifying the request, resolving which
// bot_conversations row the contact maps to, and relaying the message) is
// wired up. Returns 200 so HighLevel's setup validation doesn't fail while
// this is pending.
export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    console.log('[bot-conversation-provider] received (stub):', JSON.stringify(req.body || {}).slice(0, 500));
    return res.status(200).json({ success: true });
}
