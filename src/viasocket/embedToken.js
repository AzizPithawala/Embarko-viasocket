'use strict';

// viaSocket Embed token: an HS256 JWT signed server-side with the embed access
// key from viaSocket (Embed → Settings). The key never reaches the browser.
//
// user_id is the client store, so each store gets its own isolated set of
// Shopify / Airtable / Slack connections and flows inside viaSocket.
// Claim names follow viaSocket Embed docs (org_id, project_id, user_id); confirm
// against your viaSocket dashboard before going live.

const crypto = require('node:crypto');
const { config } = require('../config');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function storeUserId(storeId) {
  return `store_${storeId}`;
}

function embedTokenForStore(storeId) {
  const vs = config.viasocket;
  if (!vs.embedConfigured) return null;
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({ org_id: vs.orgId, project_id: vs.projectId, user_id: storeUserId(storeId), iat }, vs.accessKey);
}

// Webhook authenticity: HMAC-SHA256 of the raw body with VIASOCKET_WEBHOOK_SECRET.
function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature).replace(/^sha256=/, ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { signJwt, embedTokenForStore, storeUserId, verifySignature };
