'use strict';
/**
 * Local proxy for the image-blending webhook.
 *
 * The browser never sees the n8n URL: it POSTs to /api/blend on this server,
 * which forwards the multipart body upstream. That is the only arrangement
 * that actually hides the endpoint — a URL shipped to the client is public
 * no matter which file it was read from.
 */
const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;

// ---------------------------------------------------------------- config
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
    if (!(key in process.env)) process.env[key] = val;   // real env wins
  }
}
loadEnv(path.join(ROOT, '.env'));

const PORT        = Number(process.env.PORT || 8000);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const AUTH_HEADER = process.env.WEBHOOK_AUTH_HEADER || '';
const AUTH_VALUE  = process.env.WEBHOOK_AUTH_VALUE  || '';
const TIMEOUT_MS  = Number(process.env.TIMEOUT_MS || 60000);

// 2 files x 10MB + multipart overhead. Caps the body before we buffer it.
const MAX_BODY   = Number(process.env.MAX_BODY_BYTES || 21 * 1024 * 1024);
const RATE_MAX   = Number(process.env.RATE_MAX || 12);
const RATE_WINDOW = Number(process.env.RATE_WINDOW_MS || 5 * 60 * 1000);

if (!WEBHOOK_URL) {
  console.error('\n  WEBHOOK_URL is not set.\n  Copy .env.example to .env and put the n8n URL there.\n');
  process.exit(1);
}

// ------------------------------------------------------- security headers
// The page's inline <script>/<style> are allowed by hash, computed at boot so
// the policy stays correct when index.html is edited. No 'unsafe-inline'.
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
const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  `script-src ${inlineHashes(INDEX, 'script')}`,
  `style-src ${inlineHashes(INDEX, 'style')}`,
  // blob: for the object URLs; https: so a returned remote image still renders
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",                 // the page may only talk to this proxy
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// ----------------------------------------------------------- rate limiting
const hits = new Map();   // ip -> timestamps[]

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 1000) {   // bound the map
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW)) hits.delete(k);
  }
  return false;
}

// ---------------------------------------------------------------- helpers
function send(res, status, body, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.pause();
        reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------ proxy
async function handleBlend(req, res, ip) {
  if (rateLimited(ip)) {
    return sendJson(res, 429, { error: 'Too many requests. Wait a few minutes and try again.' });
  }

  const ctype = req.headers['content-type'] || '';
  if (!ctype.toLowerCase().startsWith('multipart/form-data')) {
    return sendJson(res, 415, { error: 'Expected multipart/form-data.' });
  }

  let body;
  try {
    body = await readBody(req, MAX_BODY);
  } catch (err) {
    if (err.code === 'TOO_LARGE') {
      sendJson(res, 413, { error: 'Upload too large.' });
      req.destroy();
      return;
    }
    return sendJson(res, 400, { error: 'Could not read the upload.' });
  }

  const headers = { 'Content-Type': ctype };
  if (AUTH_HEADER && AUTH_VALUE) headers[AUTH_HEADER] = AUTH_VALUE;

  try {
    const upstream = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    // Pass the upstream status through so the page's error handling still works,
    // but never leak upstream headers that could identify the endpoint.
    send(res, upstream.status, buf, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    console.log(`  blend -> ${upstream.status} ${buf.length}B`);
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.error('  blend failed:', err.name, err.message);
    sendJson(res, timedOut ? 504 : 502, {
      error: timedOut ? 'The image service timed out.' : 'The image service is unavailable.',
    });
  }
}

// ----------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && url === '/api/blend') return handleBlend(req, res, ip);

  if (req.method === 'GET' || req.method === 'HEAD') {
    // Explicit allow-list rather than filesystem lookup: no path traversal surface.
    if (url === '/' || url === '/index.html') {
      return send(res, 200, req.method === 'HEAD' ? '' : INDEX, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }
    if (url === '/health') return sendJson(res, 200, { ok: true });
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }

  send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain', Allow: 'GET, POST' });
});

// Refuse oversized uploads during the 100-continue handshake, so the client
// never transmits the body at all.
server.on('checkContinue', (req, res) => {
  const declared = Number(req.headers['content-length'] || 0);
  if ((req.url || '').split('?')[0] === '/api/blend' && declared > MAX_BODY) {
    return sendJson(res, 413, { error: 'Upload too large.' });
  }
  res.writeContinue();
  server.emit('request', req, res);
});

// Bind to loopback only: not reachable from the local network by default.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Image blender running at http://localhost:${PORT}`);
  console.log(`  Proxying /api/blend -> ${new URL(WEBHOOK_URL).origin}/…  (URL hidden from the browser)`);
  console.log(`  Limits: ${(MAX_BODY / 1024 / 1024).toFixed(0)}MB body, ${RATE_MAX} req / ${RATE_WINDOW / 60000} min, ${TIMEOUT_MS / 1000}s timeout\n`);
});
