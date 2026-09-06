'use strict';
/** POST /api/auth/login  { email, password } -> sets session cookies. */
const sb = require('../../lib/supabase.js');
const { setSession, readJson, clientIp } = require('../../lib/auth.js');
const { json } = require('../../lib/http.js');

// This is the endpoint worth brute-forcing, so it is throttled harder than
// /api/blend. Per-instance only: it slows attempts, it does not stop them.
const ATTEMPTS = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

function tooManyAttempts(ip) {
  const now = Date.now();
  const recent = (ATTEMPTS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) { ATTEMPTS.set(ip, recent); return true; }
  recent.push(now);
  ATTEMPTS.set(ip, recent);
  if (ATTEMPTS.size > 500) {
    for (const [k, v] of ATTEMPTS) if (!v.some((t) => now - t < WINDOW_MS)) ATTEMPTS.delete(k);
  }
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }
  if (!sb.configured()) {
    return json(res, 500, { error: 'Server is not configured. SUPABASE_URL is missing.' });
  }
  if (tooManyAttempts(clientIp(req))) {
    return json(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return json(res, 400, { error: 'Could not read the request.' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return json(res, 400, { error: 'Enter your email and password.' });

  let result;
  try { result = await sb.signIn(email, password); }
  catch { return json(res, 502, { error: 'Could not reach the sign-in service. Try again.' }); }

  const { status, data } = result;

  if (status !== 200 || !data?.access_token) {
    const code = data?.error_code || data?.error_description || data?.msg || '';
    if (/not_confirmed|not confirmed/i.test(code)) {
      return json(res, 403, { error: 'Confirm your email address before signing in.' });
    }
    // One message for both unknown-email and wrong-password, so this endpoint
    // cannot be used to enumerate who has an account.
    return json(res, 401, { error: 'Incorrect email or password.' });
  }

  setSession(req, res, data);

  let name = null;
  try { name = await sb.getProfileName(data.access_token, data.user?.id); } catch { /* non-fatal */ }

  return json(res, 200, {
    user: {
      id: data.user?.id,
      email: data.user?.email,
      name: name || data.user?.user_metadata?.name || null,
    },
  });
};
