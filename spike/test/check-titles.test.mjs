// N3: a finding or candidate from a check never shows a raw check id as its
// title. One readable title per check kind (lib/check-titles.mjs).
import "./helpers/isolated-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECK_TITLES, TLS_FALLBACK, checkTitle, readableTitle } from "../lib/check-titles.mjs";

const { ORACLES: WEB } = await import("../packs/web/pack.mjs");
const { ORACLES: MCP } = await import("../packs/ai-mcp/pack.mjs");
const { detectorsFor } = await import("../packs/domains/checks.mjs");
const { cryptoDetectors: infraCrypto } = await import("../packs/infra-cloud/checks.mjs");
const { scannerDetectors: infraScanners, SELECTED } = await import("../packs/infra-cloud/scanners.mjs");
const { CRYPTO_CHECKS } = await import("../packs/supply-chain/crypto.mjs");
const { scannerDetectors: supplyScanners } = await import("../packs/supply-chain/scanners.mjs");
const { cosignDetectors } = await import("../packs/supply-chain/cosign.mjs");
const { networkedDetectors } = await import("../packs/supply-chain/networked.mjs");
const { oracle: liveOracle } = await import("../packs/infra-cloud/live-cloud.mjs");
const { ORACLES: HOST } = await import("../packs/host/pack.mjs");
const { ORACLES: CRYPTO } = await import("../packs/crypto/pack.mjs");
const { ORACLES: FORENSICS } = await import("../packs/forensics/pack.mjs");
const { ORACLES: BINARY } = await import("../packs/binary/pack.mjs");

const ID_LIKE = /^[^\s]+$/;

test("every detector key and every oracle name has a readable title", () => {
  const ids = [
    ...Object.keys(detectorsFor("domains")), ...Object.keys(detectorsFor("surface")),
    ...CRYPTO_CHECKS, ...Object.keys(supplyScanners()), ...Object.keys(cosignDetectors()), ...Object.keys(networkedDetectors()),
    ...Object.keys(infraCrypto()), ...Object.keys(infraScanners(SELECTED)),
    ...[...WEB, ...MCP, ...HOST, ...CRYPTO, ...FORENSICS, ...BINARY, liveOracle("role")].map((o) => o.name),
  ];
  assert.ok(ids.length > 60, `${ids.length} ids`);
  for (const id of ids) {
    const title = checkTitle(id);
    assert.ok(title, `${id} has a title`);
    assert.notEqual(title, id);
    assert.ok(!ID_LIKE.test(title), `${id}: "${title}" reads as a sentence`);
  }
  // No line in the table is left over from a check that is gone.
  for (const id of Object.keys(CHECK_TITLES)) assert.ok(ids.includes(id), `${id} is a check kind`);
});

test("a tls id gets its exact title, then its family title, then the generic one", () => {
  assert.equal(checkTitle("tls-cipherlist_3des_idea"), "TLS offers weak 3DES or IDEA ciphers");
  assert.equal(checkTitle("tls-breach"), "HTTP compression over TLS (BREACH)");
  assert.equal(checkTitle("tls-dns_caarecord"), "No CAA record limits who may issue certificates");
  assert.equal(checkTitle("tls-cipherlist_NULL"), "TLS offers a weak cipher group");
  assert.equal(checkTitle("tls-cert_expirationStatus"), "A TLS certificate problem");
  assert.equal(checkTitle("tls-TLS1_1"), "An old TLS protocol version is offered");
  assert.equal(checkTitle("tls-something_new"), TLS_FALLBACK);
  assert.equal(checkTitle("not-a-check"), null);
});

test("readableTitle replaces an id-like title and keeps a sentence", () => {
  // The owner's six, as the records hold them (title = check id).
  for (const id of ["tls-cipherlist_3des_idea", "tls-breach", "weak-csp", "email-dmarc-no-reporting", "tls-dns_caarecord", "dnssec-no-ds"]) {
    const t = readableTitle(id, id);
    assert.ok(t !== id && !ID_LIKE.test(t), `${id} → ${t}`);
  }
  // A scanner title is the rule id: the tool's title replaces it.
  assert.equal(readableTitle("zizmor/unpinned-uses", "tool:zizmor"), "A CI workflow weakness (zizmor)");
  assert.equal(readableTitle("GHSA-35jh-r3h4-6jhm", "tool:grype"), "A dependency with a known vulnerability (Grype)");
  // A real sentence stays; an unknown check keeps its title.
  assert.equal(readableTitle("Signer service reachable on a NodePort", "exposed-signer-service"), "Signer service reachable on a NodePort");
  assert.equal(readableTitle("rule-L1", "rule-L1"), "rule-L1");
  assert.equal(readableTitle("", "weak-csp"), CHECK_TITLES["weak-csp"]);
});
