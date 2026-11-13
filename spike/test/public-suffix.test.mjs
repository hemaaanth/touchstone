// The Public Suffix List module: the one source of truth for public suffixes,
// registrable domains and wildcard grants that would cover other people's hosts.
//
//   node --test spike/test/public-suffix.test.mjs
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

// ---- A change of the source of truth may add refusals, never remove one ------------
// The hand lists on main before the PSL (cc2690d): live-hosts.mjs ANY_DEPTH,
// TENANT, SECOND_LEVEL and grant-store.mjs PUBLIC_SUFFIXES. Read from git, the
// old rule rebuilt from them, and every name it refused checked now.
const BEFORE_PSL = "cc2690d";
function oldSource(file) {
  try {
    return execFileSync("git", ["show", `${BEFORE_PSL}:spike/lib/${file}`], { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
const arrayIn = (src, name) => {
  const m = src.match(new RegExp(`const ${name} = (?:new Set\\()?\\[([\\s\\S]*?)\\]`));
  assert.ok(m, `the old list ${name} was found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

// main's old hand lists. From git when the commit is there; the frozen copy
// beside this test (fixtures/hand-lists-cc2690d.json, made from that same git
// show) when it is not, as in a shallow clone or an export. So the floor check
// always runs; with git, the copy must match git exactly.
const FROZEN = JSON.parse(readFileSync(new URL("./fixtures/hand-lists-cc2690d.json", import.meta.url), "utf8"));
export function oldHandLists({ git = !process.env.TOUCHSTONE_TEST_NO_GIT } = {}) {
  const live = git ? oldSource("live-hosts.mjs") : null;
  const grants = git ? oldSource("grant-store.mjs") : null;
  if (!live || !grants) return { source: "frozen copy", ...FROZEN };
  return {
    source: "git",
    ANY_DEPTH: arrayIn(live, "ANY_DEPTH"),
    TENANT: arrayIn(live, "TENANT"),
    SECOND_LEVEL: arrayIn(live, "SECOND_LEVEL"),
    PUBLIC_SUFFIXES: arrayIn(grants, "PUBLIC_SUFFIXES"),
  };
}

test("the frozen copy of main's old lists is exactly what git holds (when git has the commit)", (t) => {
  const fromGit = oldHandLists({ git: true });
  if (fromGit.source !== "git") return t.diagnostic("no git history here: the frozen copy is used, unchecked");
  for (const name of ["ANY_DEPTH", "TENANT", "SECOND_LEVEL", "PUBLIC_SUFFIXES"]) assert.deepEqual(FROZEN[name], fromGit[name], name);
});

test("without git history the floor check still has main's old lists", () => {
  const lists = oldHandLists({ git: false });
  assert.equal(lists.source, "frozen copy");
  assert.ok(lists.ANY_DEPTH.includes("amazonaws.com") && lists.TENANT.includes("wordpress.com") && lists.PUBLIC_SUFFIXES.includes("co.uk"));
});


test("every wildcard the hand lists on main refused is still refused (git or its frozen copy, depth 1 and 2)", (t) => {
  const lists = oldHandLists();
  t.diagnostic(`main's old lists from: ${lists.source}`);
  const anyDepth = lists.ANY_DEPTH;
  const tenant = lists.TENANT;
  const secondLevel = lists.SECOND_LEVEL;
  const oldSuffixes = lists.PUBLIC_SUFFIXES;
  assert.ok(anyDepth.includes("amazonaws.com") && tenant.includes("wordpress.com") && oldSuffixes.includes("co.uk"), "the right lists were read");
  // main's rule, as it was.
  const oldRefused = (b) => {
    const labels = b.split(".");
    return labels.length < 2 || anyDepth.some((e) => b === e || b.endsWith(`.${e}`)) || tenant.includes(b) || oldSuffixes.includes(b) ||
      (labels.length === 2 && secondLevel.includes(labels[0]) && /^[a-z]{2}$/.test(labels[1]));
  };
  // The names to try: each list entry at depth 1 (*.e) and depth 2 (*.x.e), and
  // every second-level label under every two-letter country code in the PSL.
  const countries = [...readFileSync(new URL("../vendor/publicsuffix/public_suffix_list.dat", import.meta.url), "utf8").matchAll(/^([a-z]{2})$/gm)].map((m) => m[1]);
  const bases = new Set();
  for (const e of [...anyDepth, ...tenant, ...oldSuffixes]) for (const b of [e, `x.${e}`, `a.b.${e}`]) bases.add(b);
  for (const l of secondLevel) for (const cc of [...countries, "zz"]) bases.add(`${l}.${cc}`);
  for (const tld of ["com", "net", "org", "uk", "de"]) bases.add(tld);
  let checked = 0;
  for (const b of bases) {
    if (!oldRefused(b)) continue;
    checked++;
    assert.ok(psl.sharedWildcardRefusal(b) || b.split(".").length < 2, `*.${b} is still refused by the rule`);
    assert.ok(liveHostsRefusal(["example.com", `*.${b}`]), `*.${b} is still refused at the create route`);
    assert.throws(() => addGrant({ hosts: [`*.${b}`], kind: "authorized", approvedBy: "test" }), /Refused/, `*.${b} is still refused by the grant store`);
  }
  assert.ok(checked > 1500, `${checked} names main refused were checked`);
});

test("the names the review found accepted after the move to the PSL are refused again", () => {
  for (const b of ["cache.amazonaws.com", "us-east-1.es.amazonaws.com", "database.windows.net", "googleusercontent.com", "wordpress.com"]) {
    assert.match(psl.sharedWildcardRefusal(b) ?? "", /covers hosts that belong to other people/, b);
    assert.throws(() => addGrant({ hosts: [`*.${b}`], kind: "authorized", approvedBy: "test" }), /covers hosts that belong to other people/, b);
  }
  // A blog's own name under wordpress.com is that blogger's space, as on main.
  assert.equal(psl.sharedWildcardRefusal("myblog.wordpress.com"), null);
});

// Provider zones where every customer gets a name. Refused, and by which rule:
// the PSL alone, the hand list alone, or both.
const ZONES = {
  "cloudfront.net": { psl: true, list: true }, "azurewebsites.net": { psl: true, list: true },
  "blob.core.windows.net": { psl: true, list: true }, "s3.amazonaws.com": { psl: true, list: true },
  "elb.amazonaws.com": { psl: true, list: true }, "herokuapp.com": { psl: true, list: true },
  "fly.dev": { psl: true, list: true }, "web.app": { psl: true, list: true }, "firebaseapp.com": { psl: true, list: true },
  "pages.dev": { psl: true, list: true }, "workers.dev": { psl: true, list: true }, "netlify.app": { psl: true, list: true },
  "onrender.com": { psl: true, list: true }, "ngrok.io": { psl: true, list: true }, "ngrok-free.app": { psl: true, list: true },
  "trycloudflare.com": { psl: true, list: true },
  "wordpress.com": { psl: false, list: true }, "googleusercontent.com": { psl: false, list: true },
  "cache.amazonaws.com": { psl: false, list: true }, "database.windows.net": { psl: false, list: true },
  "scm.azurewebsites.net": { psl: false, list: true }, "cloudapp.azure.com": { psl: false, list: true },
  "eu.ngrok.io": { psl: true, list: false }, "r.appspot.com": { psl: true, list: false }, "run.app": { psl: true, list: false },
  "duckdns.org": { psl: true, list: false }, "r2.dev": { psl: true, list: false }, "azurestaticapps.net": { psl: true, list: false },
  "elasticbeanstalk.com": { psl: true, list: false },
};
test("provider zones: each one is refused, and the table names the rule that does it", () => {
  for (const [zone, want] of Object.entries(ZONES)) {
    assert.deepEqual(psl.wildcardRefusalSources(zone), want, zone);
    assert.ok(psl.sharedWildcardRefusal(zone), `*.${zone} is refused`);
  }
});

test("the refusal and the two sources agree for every name tried here", () => {
  for (const b of [...Object.keys(ZONES), ...REFUSED, ...ACCEPTED, "example.co.uk", "edu.zz", "a.b.c.amazonaws.com"]) {
    const { psl: p, list: l } = psl.wildcardRefusalSources(b);
    assert.equal(Boolean(psl.sharedWildcardRefusal(b)), p || l, b);
  }
});
