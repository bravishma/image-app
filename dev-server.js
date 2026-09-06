'use strict';
/**
 * Local dev server. Serves index.html and routes /api/blend to the SAME
 * handler Vercel runs (api/blend.js), so local and deployed cannot drift.
 *
 * NOT named server.js on purpose: Vercel auto-detects a root server.js and
 * makes it the entire deployment's entrypoint, which bundles everything into
 * one lambda, ignores api/, and never serves index.html. Renaming this file
 * is what keeps the zero-config static + api/ layout working. Do not rename
 * it back.
 *
 * On Vercel this file is not used at all — the platform invokes
 * api/blend.js directly and serves index.html as a static asset.
 */
const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv(path.join(ROOT, '.env'));

const blend = require('./api/blend.js');

// Vercel turns every file under api/ into its own function. Locally we have to
// map the same paths by hand, so this table must mirror the api/ tree.
const API = {
  '/api/blend': blend,
  '/api/health': require('./api/health.js'),
  '/api/auth/signup': require('./api/auth/signup.js'),
  '/api/auth/login': require('./api/auth/login.js'),
  '/api/auth/logout': require('./api/auth/logout.js'),
  '/api/auth/session': require('./api/auth/session.js'),
};
const PORT = Number(process.env.PORT || 8000);

if (!process.env.WEBHOOK_URL) {
  console.error('\n  WEBHOOK_URL is not set.\n  Copy .env.example to .env and put the n8n URL there.\n');
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('\n  SUPABASE_URL / SUPABASE_ANON_KEY are not set.\n  Sign-in will fail until they are in .env.\n');
}

// Locally the CSP is computed at boot so it can never go stale. On Vercel the
// equivalent header lives in vercel.json (run `npm run csp` after editing).
function inlineHashes(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    out.push("'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
  }
  return out.join(' ') || "'none'";
}

const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    `script-src ${inlineHashes(INDEX, 'script')}`, `style-src ${inlineHashes(INDEX, 'style')}`,
    "img-src 'self' data: blob: https:", "connect-src 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

// Minimal shim for the Express-style res the Vercel handler expects.
function shim(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  if (API[url]) return API[url](req, shim(res));

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? '' : INDEX);
    }
    if (url === '/health') return shim(res).status(200).json({ ok: true });
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, POST' });
  res.end('Method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Image blender (dev) at http://localhost:${PORT}`);
  console.log(`  /api/blend -> ${new URL(process.env.WEBHOOK_URL).origin}/…  (hidden from the browser)\n`);
});
