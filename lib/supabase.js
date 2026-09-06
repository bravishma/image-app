'use strict';
/**
 * Minimal GoTrue (Supabase Auth) client over built-in fetch.
 *
 * There is no @supabase/supabase-js here on purpose: adding a dependency
 * means adding package.json, which makes Vercel classify the repo as a Node
 * server project and collapses the deployment (see CLAUDE.md). The browser
 * also cannot call Supabase directly — the CSP is connect-src 'self' — so
 * every auth call is proxied through api/auth/* exactly like /api/blend.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const TIMEOUT_MS = 10000;

function configured() {
  return Boolean(SUPABASE_URL && ANON_KEY);
}

/**
 * Returns { status, data }. Never throws for an HTTP error status — callers
 * branch on `status` — but does throw if the network call itself fails.
 */
async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { apikey: ANON_KEY, Accept: 'application/json' };
  // GoTrue accepts the anon key as the bearer when there is no user token.
  headers.Authorization = `Bearer ${token || ANON_KEY}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  return { status: res.status, data };
}

const auth = (p, opts) => request(`/auth/v1${p}`, opts);

// `data` becomes raw_user_meta_data on auth.users, which the on_auth_user_created
// trigger copies into public.profiles.name.
const signUp = (name, email, password) =>
  auth('/signup', { method: 'POST', body: { email, password, data: { name } } });

const signIn = (email, password) =>
  auth('/token?grant_type=password', { method: 'POST', body: { email, password } });

const refresh = (refreshToken) =>
  auth('/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } });

const getUser = (token) => auth('/user', { token });

const signOut = (token) => auth('/logout', { method: 'POST', token });

/** Reads the caller's own profile row. RLS applies because we pass their token. */
async function getProfileName(token, id) {
  const { status, data } = await request(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=name`,
    { token },
  );
  if (status !== 200 || !Array.isArray(data) || !data.length) return null;
  return data[0].name || null;
}

/**
 * Whether an email already has an account.
 *
 * Backed by the public.email_registered security-definer function, because
 * GoTrue deliberately returns an identical error for "no such user" and
 * "wrong password". Only used to word the sign-in error; never to gate access.
 * Returns null when the lookup itself fails, so callers fall back to the
 * generic message rather than asserting something they could not verify.
 */
async function emailRegistered(email) {
  try {
    const { status, data } = await request('/rest/v1/rpc/email_registered', {
      method: 'POST',
      body: { check_email: email },
    });
    if (status !== 200 || typeof data !== 'boolean') return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = {
  configured, signUp, signIn, refresh, getUser, signOut, getProfileName,
  emailRegistered,
};
