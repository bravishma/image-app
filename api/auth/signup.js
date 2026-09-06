'use strict';
/** POST /api/auth/signup  { name, email, password } -> sets session cookies. */
const sb = require('../../lib/supabase.js');
const { setSession, readJson } = require('../../lib/auth.js');
const { json } = require('../../lib/http.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }
  if (!sb.configured()) {
    return json(res, 500, { error: 'Server is not configured. SUPABASE_URL is missing.' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return json(res, 400, { error: 'Could not read the request.' }); }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!name || name.length > 80) return json(res, 400, { error: 'Enter your name.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email address.' });
  if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters.' });

  let result;
  try { result = await sb.signUp(name, email, password); }
  catch { return json(res, 502, { error: 'Could not reach the sign-up service. Try again.' }); }

  const { status, data } = result;

  if (status !== 200 && status !== 201) {
    const code = data?.error_code || data?.msg || data?.message || '';
    if (/already/i.test(code) || status === 422) {
      return json(res, 409, { error: 'That email is already registered. Sign in instead.' });
    }
    if (/weak_password|password/i.test(code)) {
      return json(res, 400, { error: 'Please choose a stronger password.' });
    }
    return json(res, 400, { error: 'Could not create the account.', detail: String(code).slice(0, 200) });
  }

  // With "Confirm email" enabled, GoTrue returns the user but no session.
  // Surface that clearly rather than letting the next login fail cryptically.
  if (!data?.access_token) {
    return json(res, 200, {
      user: null,
      pendingConfirmation: true,
      message: 'Account created. Check your email to confirm before signing in.',
    });
  }

  setSession(req, res, data);
  return json(res, 200, { user: { id: data.user?.id, email: data.user?.email, name } });
};
