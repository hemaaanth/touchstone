// The generic live checks: they must fire on their exact precondition and stay
// quiet around it. The five dApp-shaped checks cannot fire on a plain site, so
// without these a real run could only ever prove reflected XSS.
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORACLES, matchOracle } from "../packs/web/pack.mjs";

const oracle = (name) => ORACLES.find((o) => o.name === name);
const entry = (over) => ({ method: "GET", path: "/", url: "https://site.test/", status: 200, reqHeaders: {}, resHeaders: {}, resBody: "", ...over });
const run = () => ({ baseUrl: "https://site.test" });

test("the generic checks are registered after the dApp ones", () => {
  const names = ORACLES.map((o) => o.name);
  for (const n of ["cors-credentialed-reflection", "open-redirect", "exposed-build-artifact", "unauth-secret-in-response", "verbose-error-trace"]) {
    assert.ok(names.includes(n), `${n} is registered`);
  }
});

test("CORS fires only on a foreign reflected origin WITH credentials", () => {
  const ok = entry({ path: "/v1/me", reqHeaders: { origin: "https://touchstone.test" }, resHeaders: { "access-control-allow-origin": "https://touchstone.test", "access-control-allow-credentials": "true" }, resBody: { id: 1 } });
  assert.match(oracle("cors-credentialed-reflection").check([ok]).detail, /touchstone\.test/);

  const star = entry({ path: "/v1/me", reqHeaders: { origin: "https://touchstone.test" }, resHeaders: { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" }, resBody: {} });
  assert.equal(oracle("cors-credentialed-reflection").check([star]).pass, false, "a bare * is not usable with credentials");

  const noCreds = entry({ reqHeaders: { origin: "https://touchstone.test" }, resHeaders: { "access-control-allow-origin": "https://touchstone.test" }, resBody: {} });
  assert.equal(oracle("cors-credentialed-reflection").check([noCreds]).pass, false);

  const own = entry({ reqHeaders: { origin: "https://site.test" }, resHeaders: { "access-control-allow-origin": "https://site.test", "access-control-allow-credentials": "true" }, resBody: {} });
  assert.equal(oracle("cors-credentialed-reflection").check([own]).pass, false, "same site is not a finding");

  // Every app allowlists a dev origin; matching only that is the weak case.
  for (const dev of ["http://localhost:3000", "http://127.0.0.1:5173", "http://dev.local"]) {
    const row = entry({ reqHeaders: { origin: dev }, resHeaders: { "access-control-allow-origin": dev, "access-control-allow-credentials": "true" }, resBody: {} });
    assert.equal(oracle("cors-credentialed-reflection").check([row]).pass, false, `${dev} is a dev origin`);
  }
  // A rigged .test origin still counts.
  assert.equal(oracle("cors-credentialed-reflection").check([ok]).pass, true);
});

test("open redirect fires only when the off-site Location came from the query", () => {
  const ok = entry({ path: "/login", url: "https://site.test/login?next=https%3A%2F%2Ftouchstone.test%2Fx", status: 302, resHeaders: { location: "https://touchstone.test/x" } });
  assert.match(oracle("open-redirect").check([ok]).detail, /next/);

  const fixed = entry({ path: "/login", url: "https://site.test/login?next=https%3A%2F%2Ftouchstone.test%2F", status: 302, resHeaders: { location: "https://docs.site.test/x" } });
  assert.equal(oracle("open-redirect").check([fixed]).pass, false, "a same-site destination is not a finding");

  const bare = entry({ url: "https://site.test/login?next=touchstone.test", status: 301, resHeaders: { location: "https://touchstone.test/" } });
  assert.equal(oracle("open-redirect").check([bare]).pass, true, "a bare host value counts");
});

test("build artifacts fire on the artifact's own bytes, never on the SPA shell", () => {
  const map = entry({ path: "/assets/index-abc.js.map", resBody: '{"version":3,"mappings":"AAAA","sources":["x.js"]}' });
  assert.equal(oracle("exposed-build-artifact").check([map]).pass, true);

  const shell = entry({ path: "/assets/index-abc.js.map", resBody: '<!doctype html><html><body>app</body></html>' });
  assert.equal(oracle("exposed-build-artifact").check([shell]).pass, false, "the fallback shell is not the file");

  const git = entry({ path: "/.git/HEAD", resBody: "ref: refs/heads/main\n" });
  assert.equal(oracle("exposed-build-artifact").check([git]).pass, true);

  const env = entry({ path: "/.env", resBody: "VITE_API_URL=https://api.test\nVITE_CHAIN=1\n" });
  assert.equal(oracle("exposed-build-artifact").check([env]).pass, true);
});

test("unauth secret fires on a real value with no credential header", () => {
  const ok = entry({ path: "/config", resBody: { chain: { rpc: "https://rpc.test" }, signerPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" } });
  assert.match(oracle("unauth-secret-in-response").check([ok]).detail, /signerPrivateKey/);

  const placeholder = entry({ path: "/config", resBody: { apiKey: "your-api-key-here" } });
  assert.equal(oracle("unauth-secret-in-response").check([placeholder]).pass, false);

  const authed = entry({ path: "/config", reqHeaders: { authorization: "Bearer x" }, resBody: { apiKey: "sk-0123456789abcdef" } });
  assert.equal(oracle("unauth-secret-in-response").check([authed]).pass, false, "a credentialed call proves nothing about auth");
});

test("verbose error fires on a 5xx trace, not on a 5xx shell", () => {
  const trace = entry({ path: "/api/x", status: 500, resBody: "Error: boom\n    at handler (/srv/app/server.js:42:7)\n    at processTicksAndRejections" });
  assert.match(oracle("verbose-error-trace").check([trace]).detail, /server\.js:42/);

  const shell = entry({ path: "/api/x", status: 500, resBody: "<!doctype html><html><body>500</body></html>" });
  assert.equal(oracle("verbose-error-trace").check([shell]).pass, false);

  const four = entry({ path: "/api/x", status: 404, resBody: "Error: nope\n    at h (/a.js:1:1)" });
  assert.equal(oracle("verbose-error-trace").check([four]).pass, false);
});

test("a dApp pattern still wins over a generic one in the same transcript", () => {
  const cors = entry({ path: "/v1/me", reqHeaders: { origin: "https://touchstone.test" }, resHeaders: { "access-control-allow-origin": "https://touchstone.test", "access-control-allow-credentials": "true" }, resBody: {} });
  const replay = [
    entry({ method: "POST", path: "/siwe/verify", reqBody: { message: "m", signature: "s" }, resBody: { token: "a" } }),
    entry({ method: "POST", path: "/siwe/verify", reqBody: { message: "m", signature: "s" }, resBody: { token: "b" } }),
  ];
  assert.equal(matchOracle([...replay, cors], run()).oracle.name, "siwe-nonce-replay");
});
