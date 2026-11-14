// Kept self-contained so the same function can be injected into live containers.
export async function requestWithRedirects(send, record, method, url, headers, body, { followRedirects = true, maxRedirects = 10 } = {}) {
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw new Error("maxRedirects must be between 0 and 20");
  method = method.toUpperCase();
  headers = { ...headers };
  const seen = new Set();
  const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };
  for (let hop = 0; ; hop++) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Redirect request requires an HTTP(S) URL without credentials");
    const key = method + " " + url.href;
    if (seen.has(key)) throw new Error("Redirect loop");
    seen.add(key);
    const res = await send(url, method, headers, body);
    const entry = { method, path: url.pathname, url: url.href, reqHeaders: { ...headers }, reqBody: body === undefined ? null : parse(body), status: res.status, resHeaders: res.headers, resBody: parse(res.body) };
    record(entry);
    if (!followRedirects || ![301, 302, 303, 307, 308].includes(res.status) || !res.headers.location) return entry;
    if (hop >= maxRedirects) throw new Error("Redirect limit exceeded");
    const next = new URL(res.headers.location, url);
    if (next.origin !== url.origin) {
      // Never carry caller credentials or a forged Host to another origin.
      for (const name of Object.keys(headers)) {
        if (["authorization", "proxy-authorization", "cookie", "host"].includes(name.toLowerCase())) delete headers[name];
      }
    }
    if ((res.status === 303 && method !== "HEAD") || ([301, 302].includes(res.status) && method === "POST")) {
      method = "GET";
      body = undefined;
      for (const name of Object.keys(headers)) if (["content-type", "content-length", "transfer-encoding"].includes(name.toLowerCase())) delete headers[name];
    }
    url = next;
  }
}

// A retrying send, for the live lane only. Real targets rate-limit: a public API
// behind Cloudflare answers 429 to a burst, and a script that fired twenty
// requests in one second gets twenty 429s and learns nothing. Retrying inside
// `send` is invisible to the caller and to the transcript: the recorded exchange
// is the one that finally counted.
//
// Bounded on purpose. At most `attempts` tries, at most `maxWaitMs` waited in
// total, and 20 s is the longest single wait (a Retry-After above that is capped,
// so one header cannot eat the script's whole wall clock). When the wait budget
// runs out the 429 is returned as-is, so the agent still sees the real answer and
// can pace itself or widen the gap.
export const retrySend = (send, { attempts = 3, maxWaitMs = 10_000, maxSingleMs = 20_000 } = {}) => async (url, method, headers, body) => {
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    const res = await send(url, method, headers, body);
    if ((res.status !== 429 && res.status !== 503) || attempt >= attempts) return res;
    // Only a real header sets the wait; Number("") is 0 and would otherwise
    // disable the backoff for every response that carries none.
    const after = String(res.headers?.["retry-after"] ?? "").trim();
    const seconds = after && Number.isFinite(Number(after)) ? Math.max(0, Number(after)) : null;
    const wait = seconds === null
      ? Math.min(500 * 2 ** (attempt - 1), 8000)
      : Math.min(seconds * 1000, maxSingleMs);
    if (waited + wait > maxWaitMs) return res;
    await new Promise((resolve) => setTimeout(resolve, wait));
    waited += wait;
  }
};
