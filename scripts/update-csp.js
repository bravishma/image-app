'use strict';
// Regenerates the CSP script/style hashes in vercel.json from index.html.
// Run after ANY edit to index.html's inline <script> or <style>, or the
// deployed page's JavaScript is silently blocked by the browser.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cfgPath = path.join(root, 'vercel.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const hashes = (tag) => {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    out.push("'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
  }
  return out.join(' ') || "'none'";
};

const csp = [
  "default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  `script-src ${hashes('script')}`, `style-src ${hashes('style')}`,
  "img-src 'self' data: blob: https:", "connect-src 'self'",
].join('; ');

const header = cfg.headers[0].headers.find((h) => h.key === 'Content-Security-Policy');
const changed = header.value !== csp;
header.value = csp;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(changed ? 'vercel.json CSP updated' : 'vercel.json CSP already current');
