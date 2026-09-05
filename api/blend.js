'use strict';
/**
 * Serverless proxy for the image-blending webhook (Vercel: /api/blend).
 *
 * Holds WEBHOOK_URL server-side so the browser never sees it. server.js
 * imports this same handler for local dev, so the two stay in sync.
 */

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const AUTH_HEADER = process.env.WEBHOOK_AUTH_HEADER || '';
const AUTH_VALUE  = process.env.WEBHOOK_AUTH_VALUE  || '';
const TIMEOUT_MS  = Number(process.env.TIMEOUT_MS || 55000);

// Vercel rejects request bodies over ~4.5MB before they reach this code, so
// the client downscales images first. This is a backstop, not the real guard.
const MAX_BODY    = Number(process.env.MAX_BODY_BYTES || 4 * 1024 * 1024);
const RATE_MAX    = Number(process.env.RATE_MAX || 12);
const RATE_WINDOW = Number(process.env.RATE_WINDOW_MS || 5 * 60 * 1000);

// Per-instance only. Serverless instances are ephemeral and run in parallel,
// so this throttles a single hot instance, not your account. Real enforcement
// needs a shared store (Vercel KV / Upstash).
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  if (recent.length >= RATE_MAX) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW)) hits.delete(k);
  }
  return false;
}

function readRawBody(req, limit) {
  // Vercel may have already buffered the body depending on content type.
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.pause();
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!WEBHOOK_URL) {
    console.error('WEBHOOK_URL is not set in the environment');
    return res.status(500).json({
      error: 'Server is not configured. WEBHOOK_URL is missing.',
    });
  }

  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : (fwd || '')).split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown';

  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Wait a few minutes and try again.' });
  }

  const ctype = req.headers['content-type'] || '';
  if (!ctype.toLowerCase().startsWith('multipart/form-data')) {
    return res.status(415).json({ error: 'Expected multipart/form-data.' });
  }

  let body;
  try {
    body = await readRawBody(req, MAX_BODY);
  } catch (err) {
    if (err.code === 'TOO_LARGE') {
      return res.status(413).json({ error: 'Images are too large. Try smaller photos.' });
    }
    return res.status(400).json({ error: 'Could not read the upload.' });
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
    // Pass the status through; never echo upstream headers that would
    // identify the endpoint.
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    return res.end(buf);
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.error('blend failed:', err.name, err.message);
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'The image service timed out.' : 'The image service is unavailable.',
    });
  }
};
