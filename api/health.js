'use strict';
/**
 * Minimal diagnostic function. Deliberately has no dependencies and no logic
 * beyond reporting config presence, so that if THIS crashes the fault is the
 * platform or project settings, not the proxy in api/blend.js.
 * Never returns the webhook URL itself — only whether it is set.
 */
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    node: process.version,
    hasWebhookUrl: Boolean(process.env.WEBHOOK_URL),
    webhookUrlLooksValid: /^https?:\/\/.+/.test(process.env.WEBHOOK_URL || ''),
    hasAuthHeader: Boolean(process.env.WEBHOOK_AUTH_HEADER),
    region: process.env.VERCEL_REGION || null,
    env: process.env.VERCEL_ENV || null,
  }));
};
