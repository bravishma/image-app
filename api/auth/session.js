'use strict';
/** GET /api/auth/session -> { user } or { user: null }. Refreshes if needed. */
const sb = require('../../lib/supabase.js');
const { requireUser } = require('../../lib/auth.js');
const { json } = require('../../lib/http.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'Method not allowed.' });
  }

  let user = null;
  try { user = await requireUser(req, res); } catch { /* treat as signed out */ }
  if (!user) return json(res, 200, { user: null });

  let name = null;
  try { name = await sb.getProfileName(user.token, user.id); } catch { /* non-fatal */ }

  return json(res, 200, { user: { id: user.id, email: user.email, name } });
};
