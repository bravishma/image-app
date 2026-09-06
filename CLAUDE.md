# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node dev-server.js          # run the app -> http://localhost:8000
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
- **`dev-server.js`** — a zero-dependency proxy. Also serves `index.html`.

### Why the proxy exists

The n8n webhook is unauthenticated, so anyone who reads its URL can burn Gemini
credits. A URL placed in client-side JavaScript is public regardless of where it
was read from — a `.env` consumed at build time does not hide it. So the URL
lives only in `.env` on the server, and the browser posts to same-origin
`/api/blend`.

**Do not reintroduce the webhook URL into `index.html`.** That silently undoes
the entire security model.

### Auth (Supabase), same proxy pattern

Sign-up / sign-in run through `api/auth/*`, which call Supabase's GoTrue REST
API with built-in `fetch`. The browser never talks to `*.supabase.co` — it
can't: the CSP is `connect-src 'self'`. Two constraints force this shape and
both are load-bearing:

- **No `@supabase/supabase-js`.** Installing it means a `package.json`, which
  breaks the Vercel deployment (see below). `lib/supabase.js` is the whole
  client, ~70 lines of `fetch`.
- **Sessions are httpOnly cookies** (`sb_at` / `sb_rt`), set by the API
  functions. No token is ever readable from page JavaScript. `requireUser()`
  in `lib/auth.js` validates the access token and silently refreshes it, so
  both `/api/blend` and `/api/auth/session` get refresh for free.

`Secure` is set on those cookies only over https — the local dev server speaks
plain http, which would otherwise drop them silently.

The user's name lives in `public.profiles`, populated from
`raw_user_meta_data` by the `on_auth_user_created` trigger. Never base an RLS
policy on `user_metadata`: it is user-editable (Supabase lint 0015), which is
the whole reason the name is mirrored into a real column.

**"Confirm email" must stay OFF** in the Supabase dashboard (Authentication ->
Providers -> Email). With it on, signup returns a user but no session, and
Supabase's built-in SMTP caps out at a couple of emails per hour — signups
then fail with `over_email_send_rate_limit`. `api/auth/signup.js` detects the
session-less response and reports it rather than failing cryptically.

### Footgun: the gate is a second attribute, not a `data-state` value

`data-state` is a single-slot enum that ~10 CSS rules key off and that
`setState()` overwrites on every transition. The auth gate therefore uses an
**independent** `data-auth` attribute (`checking`/`out`/`in`) on the same
`#app` element. Adding a `locked` value to `data-state` instead would mean
auditing every one of those rules.

### Footgun: CSP hashes are computed at boot

`dev-server.js` sha256-hashes the inline `<script>` and `<style>` blocks of
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

## Deployment (Vercel)

Zero-config: `index.html` is served statically and each file in `api/` becomes
a function. Two things must stay true or every URL returns
`FUNCTION_INVOCATION_FAILED`:

- **No `package.json` at the root.** Its presence makes Vercel classify the
  repo as a Node.js *server* project and look for a server entrypoint,
  which collapses the whole deployment into one lambda (or fails the build).
  The project has no dependencies, so it does not need one.
- **No `server.js`/`app.js`/`index.js`/`main.js` at the root**, for the same
  reason — Vercel auto-detects those names as the app entrypoint. The local
  dev server is deliberately called `dev-server.js`.

`WEBHOOK_URL`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` must be set in the
Vercel project's environment variables; `.env` is local-only and never
uploaded. Vercel turns every file under `api/` into its own function,
nested ones included, so `api/auth/login.js` serves `/api/auth/login`.
`dev-server.js` has to map those paths by hand — the `API` table near the top
must mirror the `api/` tree or a route 404s locally while working in prod.

## Constraints

- `index.html` must stay self-contained (no external assets, no CDN) — the CSP
  is `default-src 'none'` with `connect-src 'self'`.
- Client-side file validation (10MB, PNG/JPG/WEBP) is duplicated in `dev-server.js`
  only as a total-body cap; the proxy does not parse multipart.
- Object URLs are revoked before every replacement — keep that discipline when
  adding image sources.
