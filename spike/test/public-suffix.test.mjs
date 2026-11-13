// The Public Suffix List module: the one source of truth for public suffixes,
// registrable domains and wildcard grants that would cover other people's hosts.
//
//   node --test spike/test/public-suffix.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const psl = await import("../lib/public-suffix.mjs");
const { addGrant, PUBLIC_SUFFIXES } = await import("../lib/grant-store.mjs");
const { liveHostsRefusal } = await import("../lib/live-hosts.mjs");
const { caaNames } = await import("../packs/domains/tls.mjs");

test("the vendored list is the one the comment names", () => {
  const file = new URL("../vendor/publicsuffix/public_suffix_list.dat", import.meta.url);
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  const src = readFileSync(new URL("../lib/public-suffix.mjs", import.meta.url), "utf8");
  assert.ok(src.includes(sha), "public-suffix.mjs records the sha256 of the file");
  const head = readFileSync(file, "utf8").slice(0, 400);
  assert.match(head, /Mozilla Public\n\/\/ License, v\. 2\.0/, "the MPL header is kept");
});

// From publicsuffix.org's own test file (tests/test_psl.txt), checkPublicSuffix:
// the registrable domain of a name, or null. IDN names come back in punycode.
test("the publicsuffix.org test vectors that matter", () => {
  const cases = [
    ["com", null], ["example.com", "example.com"], ["www.example.com", "example.com"],
    ["uk.com", null], ["example.uk.com", "example.uk.com"], ["b.example.uk.com", "example.uk.com"], ["a.b.example.uk.com", "example.uk.com"],
    ["test.ac", "test.ac"],
    // a wildcard rule: *.mm
    ["mm", null], ["c.mm", null], ["b.c.mm", "b.c.mm"], ["a.b.c.mm", "b.c.mm"],
    ["jp", null], ["test.jp", "test.jp"], ["www.test.jp", "test.jp"], ["ac.jp", null], ["test.ac.jp", "test.ac.jp"],
    ["kyoto.jp", null], ["test.kyoto.jp", "test.kyoto.jp"], ["ide.kyoto.jp", null], ["b.ide.kyoto.jp", "b.ide.kyoto.jp"],
    // *.kobe.jp with the exception !city.kobe.jp
    ["c.kobe.jp", null], ["b.c.kobe.jp", "b.c.kobe.jp"], ["city.kobe.jp", "city.kobe.jp"], ["www.city.kobe.jp", "city.kobe.jp"],
    // *.ck with the exception !www.ck
    ["ck", null], ["test.ck", null], ["b.test.ck", "b.test.ck"], ["www.ck", "www.ck"], ["www.www.ck", "www.ck"],
    ["us", null], ["test.us", "test.us"], ["ak.us", null], ["test.ak.us", "test.ak.us"], ["k12.ak.us", null], ["test.k12.ak.us", "test.k12.ak.us"],
    // IDN, in Unicode and in punycode
    ["食狮.com.cn", "xn--85x722f.com.cn"], ["www.食狮.com.cn", "xn--85x722f.com.cn"], ["shishi.中国", "shishi.xn--fiqs8s"], ["中国", null],
    ["xn--85x722f.com.cn", "xn--85x722f.com.cn"], ["xn--fiqs8s", null],
    // a TLD the list does not hold: the "*" rule
    ["example", null], ["example.example", "example.example"], ["b.example.example", "example.example"],
    // upper case and a trailing dot
    ["WwW.Example.COM.", "example.com"],
  ];
  for (const [host, want] of cases) assert.equal(psl.registrableDomain(host), want, host);
});

test("both PSL sections count, and the decider is named", () => {
  assert.deepEqual(psl.suffixOf("example.co.uk"), { suffix: "co.uk", section: "icann" });
  assert.deepEqual(psl.suffixOf("myapp.vercel.app"), { suffix: "vercel.app", section: "private" });
  assert.deepEqual(psl.suffixOf("x.r.appspot.com"), { suffix: "x.r.appspot.com", section: "private" });
  assert.deepEqual(psl.suffixOf("host.example"), { suffix: "example", section: "default" });
  assert.equal(psl.isPublicSuffix("vercel.app"), true);
  assert.equal(psl.isPublicSuffix("myapp.vercel.app"), false);
  assert.equal(psl.hasSuffixUnder("amazonaws.com"), true);
  assert.equal(psl.hasSuffixUnder("example.com"), false);
});

// The 2d review's lists. Refused by the one rule, through the grant store too
// (POST /api/grants takes wildcards directly).
const REFUSED = [
  "scm.azurewebsites.net", "r.appspot.com", "eu.ngrok.io", "elasticbeanstalk.com", "blogspot.co.uk", "cloudapp.azure.com",
  "azurestaticapps.net", "run.app", "r2.dev", "duckdns.org", "ne.jp", "vercel.app", "amazonaws.com", "eu-west-1.amazonaws.com",
  "nip.io", "1.2.3.4.nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "co.uk", "com.de", "co.nz", "github.io", "blob.core.windows.net",
];
const ACCEPTED = ["example.com", "app.example.co.uk", "myapp.vercel.app", "shop.myshopify.com", "x.up.railway.app", "example.com.de", "example.org", "corp.example.io", "example.ne.jp"];

test("a wildcard over names that belong to other people is refused by the grant store", () => {
  for (const base of REFUSED) {
    assert.ok(psl.sharedWildcardRefusal(base), base);
    assert.throws(() => addGrant({ hosts: [`*.${base}`], kind: "authorized", approvedBy: "test" }), /^Error: Refused: "\*\..+" covers hosts that belong to other people/, base);
  }
});

test("a wildcard under the operator's own name is still accepted, in the route and in the grant store", () => {
  for (const base of ACCEPTED) {
    assert.equal(psl.sharedWildcardRefusal(base), null, base);
    assert.equal(liveHostsRefusal([base, `*.${base}`]), null, base);
    assert.deepEqual(addGrant({ hosts: [base, `*.${base}`], kind: "authorized", approvedBy: "test" }).hosts, [base, `*.${base}`]);
  }
});

// What a scope accepts today for a normal domain is not refused now.
test("ordinary plain websites are not refused", () => {
  const plain = [
    "example.com", "https://example.com", "https://app.example.com:8443/login", "http://shop.example.co.uk", "example.com.au",
    "www.example.org", "api.example.io", "example.dev", "sub.example.ne.jp", "myapp.vercel.app", "xn--bcher-kva.de", "bücher.de",
  ];
  for (const h of plain) assert.equal(liveHostsRefusal([h]), null, h);
  // A local lab (the private-address opt-in is the grant store's question).
  for (const h of ["localhost", "127.0.0.1", "http://127.0.0.1:8080", "[::1]"]) assert.equal(liveHostsRefusal([h]), null, h);
  // A supply-chain scope names GitHub repos: its own code checks them.
  assert.equal(liveHostsRefusal(["octokit/request-error.js", "octokit/core.js@main"], { pack: "supply-chain" }), null);
});

test("the Domains CAA walk stops at the registrable domain the PSL gives", () => {
  assert.equal(PUBLIC_SUFFIXES.has("co.uk"), true);
  assert.equal(PUBLIC_SUFFIXES.has("example.co.uk"), false);
  assert.deepEqual(caaNames("www.example.co.uk"), ["www.example.co.uk", "example.co.uk"]);
  // A suffix the old hand list lacked: ne.jp.
  assert.deepEqual(caaNames("www.example.ne.jp"), ["www.example.ne.jp", "example.ne.jp"]);
  assert.deepEqual(caaNames("a.myapp.vercel.app"), ["a.myapp.vercel.app", "myapp.vercel.app"]);
  assert.deepEqual(caaNames("co.uk"), []);
});

test("the list is parsed once and fast", () => {
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) psl.registrableDomain(`h${i}.a.b.example.co.uk`);
  assert.ok(performance.now() - t0 < 200, "1,000 lookups in under 200 ms");
});
