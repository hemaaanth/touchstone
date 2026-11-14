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
