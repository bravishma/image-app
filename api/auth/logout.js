'use strict';
/** POST /api/auth/logout -> revokes the session upstream and clears cookies. */
const sb = require('../../lib/supabase.js');
const { readCookies, clearSession } = require('../../lib/auth.js');
const { json } = require('../../lib/http.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed.' });
  }

  const token = readCookies(req).sb_at;
  // Best effort: the cookies get cleared either way, so a failure upstream
  // must not leave the browser thinking it is still signed in.
  if (token) { try { await sb.signOut(token); } catch { /* ignore */ } }

  clearSession(req, res);
  return json(res, 200, { user: null });
};
