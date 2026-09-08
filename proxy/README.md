# API proxy (optional)

Summary works without this. It exists to remove the app's one uncomfortable
trade-off: by default the Anthropic API key is stored in the browser's
`localStorage` and sent from the page, which means anything with script access
to the origin can read it.

With a proxy deployed, the key lives in the Worker's secret store instead. The
page sends the same request body and no credentials at all.

## Deploy to Cloudflare Workers

```bash
npm create cloudflare@latest -- summary-proxy
cd summary-proxy
cp ../proxy/cloudflare-worker.js src/index.js
npx wrangler secret put ANTHROPIC_API_KEY      # paste the key when prompted
```

Set the allowed origin in `wrangler.toml` so the proxy is not an open relay for
your key:

```toml
[vars]
ALLOWED_ORIGIN = "https://webrunner10810.github.io"
```

```bash
npx wrangler deploy
```

Then paste the Worker URL into **Settings → Proxy URL** in the app. The API key
field disappears once a proxy is set, because the app no longer needs one.

## What it does and does not do

- Forwards only `POST /v1/messages`, and only `content-type`,
  `anthropic-version` and `anthropic-beta` from the caller. A client-supplied
  `x-api-key` is dropped rather than passed through.
- Streams the response body untouched, so SSE frames arrive as they are
  produced and the app's progress bar keeps working.
- Preserves `retry-after` so the app's backoff honours it.
- Rejects requests from any origin other than `ALLOWED_ORIGIN` unless that is
  explicitly set to `*`.

It does **not** add authentication of its own. Anyone who can reach the Worker
from the allowed origin can spend your API credits. If it will be shared beyond
you, put Cloudflare Access in front of it or add your own auth check at the top
of `fetch`.

The same code runs with minor edits on any platform with a `fetch` handler and
streaming responses — Deno Deploy, Vercel Edge, Netlify Edge.
