'use strict';
/**
 * Session handling for Supabase Auth.
 *
 * Tokens live in httpOnly cookies, never in page JavaScript. That matters
 * because index.html renders images coming back from an external workflow;
 * a token in localStorage would be reachable if anything on the page were
 * ever coerced into running attacker-influenced script.
 */
const sb = require('./supabase.js');

const ACCESS_COOKIE = 'sb_at';
const REFRESH_COOKIE = 'sb_rt';
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

function configured() {
  return sb.configured();
}

function readCookies(req) {
  const out = {};
  const raw = req.headers?.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// Secure cookies are dropped outright over plain http, which is what the local
// dev server speaks — so only set the flag when we are actually on https.
function isSecure(req) {
  if (process.env.VERCEL) return true;
  const proto = req.headers?.['x-forwarded-proto'];
  return (Array.isArray(proto) ? proto[0] : proto) === 'https';
}

function cookie(name, value, maxAge, secure) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

function setSession(req, res, session) {
  const secure = isSecure(req);
  res.setHeader('Set-Cookie', [
    cookie(ACCESS_COOKIE, session.access_token, Number(session.expires_in) || 3600, secure),
    cookie(REFRESH_COOKIE, session.refresh_token, REFRESH_MAX_AGE, secure),
  ]);
}

function clearSession(req, res) {
  const secure = isSecure(req);
  res.setHeader('Set-Cookie', [
    cookie(ACCESS_COOKIE, '', 0, secure),
    cookie(REFRESH_COOKIE, '', 0, secure),
  ]);
}

/**
 * Resolves the caller to a user, transparently refreshing an expired access
 * token and re-issuing cookies when it can. Returns { id, email, token } or
 * null. Shared by /api/blend and /api/auth/session so refresh happens on any
 * request, not just an explicit one.
 */
async function requireUser(req, res) {
  if (!configured()) return null;
  const jar = readCookies(req);

  if (jar[ACCESS_COOKIE]) {
    const { status, data } = await sb.getUser(jar[ACCESS_COOKIE]);
    if (status === 200 && data?.id) {
      return { id: data.id, email: data.email, token: jar[ACCESS_COOKIE] };
    }
  }

  if (jar[REFRESH_COOKIE]) {
    const { status, data } = await sb.refresh(jar[REFRESH_COOKIE]);
    if (status === 200 && data?.access_token) {
      setSession(req, res, data);
      const u = data.user || {};
      return { id: u.id, email: u.email, token: data.access_token };
    }
    clearSession(req, res); // refresh token is dead; stop sending it
  }

  return null;
}

/**
 * Vercel's Node runtime parses JSON bodies into req.body; the local dev
 * server does not. Handle both.
 */
async function readJson(req, limit = 8 * 1024) {
  if (req.body && typeof req.body === 'object') return req.body;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : (fwd || '')).split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown';
}

module.exports = {
  configured, readCookies, setSession, clearSession, requireUser, readJson, clientIp,
};
