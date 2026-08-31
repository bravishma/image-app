# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node server.js          # run the app -> http://localhost:8000
```

No dependencies, no build step, no `npm install`, no `package.json`. Node 18+
(relies on built-in `fetch`, `AbortSignal.timeout`).

There is no test framework. The checks used during development were ad-hoc:

```bash
# syntax-check the inline browser JS (it lives inside index.html)
python3 -c "
import re; src=open('index.html').read()
open('/tmp/check.js','w').write(re.findall(r'<script>(.*?)</script>',src,re.S)[-1])"
node --check /tmp/check.js
node --check server.js

# verify the served CSP hashes still match index.html (see footgun below)
curl -s -D - -o /dev/null localhost:8000/ | grep -i content-security-policy
```

## Architecture

Two source files, ~1000 lines total:

```
browser (index.html)  ──POST /api/blend──►  server.js  ──POST──►  n8n webhook
                      ◄────image/png──────             ◄──────────  (Gemini 2.5)
```

- **`index.html`** — the entire UI in one file: inline `<style>` and `<script>`,
  no framework, no imports. Upload slots are cloned from a `<template>` and
  wired by a single `createUploadSlot()` factory. UI state is one
  `data-state` attribute (`idle`/`ready`/`loading`/`done`/`error`) on `#app`
  that CSS keys off; `setState()` is the only mutator.
- **`server.js`** — a zero-dependency proxy. Also serves `index.html`.

### Why the proxy exists

The n8n webhook is unauthenticated, so anyone who reads its URL can burn Gemini
credits. A URL placed in client-side JavaScript is public regardless of where it
was read from — a `.env` consumed at build time does not hide it. So the URL
lives only in `.env` on the server, and the browser posts to same-origin
`/api/blend`.

**Do not reintroduce the webhook URL into `index.html`.** That silently undoes
the entire security model.

### Footgun: CSP hashes are computed at boot

`server.js` sha256-hashes the inline `<script>` and `<style>` blocks of
`index.html` at startup and emits them in the CSP (deliberately avoiding
`unsafe-inline`). **After editing `index.html` you must restart the server**, or
the browser silently refuses to execute the page's JavaScript — the page renders
but nothing works, with no visible error outside the console.

### Response handling

`resolveImageSrc()` in `index.html` tolerates every shape n8n might return:
raw binary (the confirmed-working path), JSON `{url}`, a JSON array, a `data:`
URI, or bare base64. It rejects anything that isn't `https:` or `data:image/`,
which is what keeps a hostile `src` out of the DOM — preserve that check when
touching it. Errors surface as a fixed user-facing message plus a technical
detail line.

## n8n workflow gotchas

These cost significant debugging time and are invisible from the front-end,
which behaves identically across all of them:

1. Uploads arrive as binary properties named **`image1`** / **`image2`**
   (inherited from the form field names) — *not* n8n's default `data`. A node
   left on `data` fails with a misleading "Service unavailable".
2. A `Respond to Webhook` node present while the Webhook trigger's `Respond` is
   not set to "Using 'Respond to Webhook' Node" throws *"Unused Respond to
   Webhook node found"*.
3. `Respond: When Last Node Finishes` + `Response Data: First Entry Binary`
   returns the **first** binary property. If the blend result isn't first, an
   unmodified input is echoed back and it looks like nothing happened.
4. **HTTP 200 with an empty body means the workflow died before responding.**
   Read the n8n Executions tab, not the browser.

n8n reports several internal node failures as "Service unavailable — try again
later". Check whether it reproduces before treating it as transient.

## Constraints

- `index.html` must stay self-contained (no external assets, no CDN) — the CSP
  is `default-src 'none'` with `connect-src 'self'`.
- Client-side file validation (10MB, PNG/JPG/WEBP) is duplicated in `server.js`
  only as a total-body cap; the proxy does not parse multipart.
- Object URLs are revoked before every replacement — keep that discipline when
  adding image sources.
