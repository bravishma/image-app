# AI Image Blender

Upload a photo of a person and a photo of an accessory (e.g. a hat); an n8n
workflow backed by Gemini 2.5 blends them and the result is displayed and
downloadable.

## Running it

```bash
cp .env.example .env     # then put your real webhook URL in .env
node dev-server.js           # http://localhost:8000
```

No dependencies, no build step, no `npm install`. Node 18+ (uses built-in `fetch`).

## Architecture

```
browser (index.html)  ──POST /api/blend──►  server.js  ──POST──►  n8n webhook
                      ◄────image/png──────             ◄──────────  (Gemini 2.5)
```

Two files do all the work:

- **`index.html`** — the entire UI: upload slots, previews, validation, state
  machine, result viewer. Inline CSS/JS, no framework.
- **`dev-server.js`** — a proxy that holds the webhook URL and enforces limits.

### Why the proxy exists

The browser must never see the n8n URL. The webhook is unauthenticated, so
anyone who reads it can burn your Gemini credits. Putting it in a `.env` and
inlining it into client-side JavaScript would **not** help — the value still
ships to the browser in plain text. Only a server the browser talks to
*instead* actually hides it.

So `index.html` posts to same-origin `/api/blend`, and `dev-server.js` reads
`WEBHOOK_URL` from `.env` and forwards the request.

## Configuration (`.env`)

| Key | Default | Purpose |
| :-- | :-- | :-- |
| `WEBHOOK_URL` | *(required)* | n8n webhook. Never sent to the browser. |
| `WEBHOOK_AUTH_HEADER` / `WEBHOOK_AUTH_VALUE` | – | Set both if you enable Header Auth on the n8n Webhook node. |
| `PORT` | `8000` | Listen port (loopback only). |
| `TIMEOUT_MS` | `60000` | Upstream request timeout. |
| `MAX_BODY_BYTES` | `22020096` | Max upload (~21MB = 2×10MB + overhead). |
| `RATE_MAX` / `RATE_WINDOW_MS` | `12` / `300000` | Rate limit per IP. |

`.env` is gitignored; `.env.example` is the committable template.

## Security posture

- Webhook URL server-side only; upstream headers are not passed back.
- Per-IP rate limiting; oversized uploads refused at the `100-continue`
  handshake, before the body is transmitted.
- CSP with **per-hash** allowances for the inline `<script>`/`<style>` — no
  `unsafe-inline`. `connect-src 'self'` means the page can only talk to this
  proxy. Plus `nosniff`, `DENY` framing, `no-referrer`.
- Static routes are an explicit allow-list, so there is no path-traversal surface.
- Server binds to `127.0.0.1` — not reachable from your network by default.

> **Editing `index.html` requires restarting the server.** The CSP script/style
> hashes are computed at boot; if they go stale the browser silently refuses to
> run the page's JavaScript.

### Not covered

The webhook itself is still open to anyone who knows the URL — the proxy hides
it from *your users*, but does not protect the endpoint. To close that, enable
**Header Auth** on the n8n Webhook node and set the two `WEBHOOK_AUTH_*` vars.
There is also no login: anyone who can reach the server can use it.

## n8n workflow notes

Two traps that cost real debugging time:

1. Uploads arrive as binary properties named **`image1`** / **`image2`**
   (inherited from the form field names) — *not* n8n's default `data`. A node
   left on `data` fails confusingly.
2. `Respond: When Last Node Finishes` + `Response Data: First Entry Binary`
   returns the **first** binary property. If the blend result isn't first,
   you get an unmodified input echoed back and it looks like nothing happened.
   Use a `Respond to Webhook` node to name the property explicitly.

An HTTP 200 with an empty body means the workflow died before responding —
check the n8n **Executions** tab, not the browser.

## Response handling

`resolveImageSrc()` in `index.html` accepts whatever the workflow returns:
raw binary, JSON `{url}`, a JSON array, a `data:` URI, or bare base64. Binary
is the confirmed-working path; the others are unit-tested fallbacks.
