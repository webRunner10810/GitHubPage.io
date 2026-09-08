/**
 * Optional API proxy for Summary.
 *
 * Deploying this removes the one genuinely uncomfortable trade-off in the app:
 * with a proxy configured, the Anthropic API key lives in the Worker's secret
 * store and never reaches the browser. The page sends the same request body it
 * would send directly; this Worker adds the credentials and streams the
 * response straight back.
 *
 * Deploy:
 *   npm create cloudflare@latest -- summary-proxy
 *   # replace src/index.js with this file, then:
 *   npx wrangler secret put ANTHROPIC_API_KEY
 *   npx wrangler deploy
 *
 * Then set ALLOWED_ORIGIN (in wrangler.toml [vars]) to the exact origin the app
 * is served from, and paste the Worker URL into Settings → Proxy URL.
 */

const API_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

/** Only these reach the upstream API — never a client-supplied credential. */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'anthropic-version', 'anthropic-beta'];

function corsHeaders(origin, allowed) {
  return {
    'access-control-allow-origin': allowed === '*' ? '*' : origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, anthropic-version, anthropic-beta',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    const origin = request.headers.get('origin') || '';
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // An unrestricted proxy is someone else's free API key. Refuse by default
    // unless the deployment has explicitly opted into a wildcard.
    if (allowed !== '*' && origin !== allowed) {
      return json(403, { error: { type: 'forbidden', message: 'Origin not allowed.' } }, cors);
    }

    const url = new URL(request.url);
    if (request.method !== 'POST' || !url.pathname.endsWith('/v1/messages')) {
      return json(404, { error: { type: 'not_found', message: 'Only POST /v1/messages is proxied.' } }, cors);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json(500, {
        error: { type: 'configuration_error', message: 'ANTHROPIC_API_KEY is not set on the proxy.' },
      }, cors);
    }

    const headers = new Headers({
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': API_VERSION,
    });
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const upstream = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers,
      body: request.body,
      // Required by Workers when streaming a request body through.
      duplex: 'half',
    });

    // Stream the response through untouched so the client sees SSE frames as
    // they arrive rather than after the whole message completes.
    const responseHeaders = new Headers(cors);
    const contentType = upstream.headers.get('content-type');
    if (contentType) responseHeaders.set('content-type', contentType);
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) responseHeaders.set('retry-after', retryAfter);
    responseHeaders.set('cache-control', 'no-store');

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};
