// NEAR AI Cloud TEE attestation — the one capability no other provider gives us.
//
// A run on NEAR AI Cloud runs an abliterated (refusal-removed) model inside an
// Intel TDX + NVIDIA H100 enclave. The gateway exposes a PUBLIC, key-less report
//   GET <baseUrl>/attestation/report?model=<id>
// that is signed by the enclave and names the exact model plus the measured
// software that served it (compose_hash / os_image_hash / mr_aggregated). We
// capture a compact summary + a content hash per run so a finding can carry
// hardware provenance — and so a run on ANY OTHER provider is visibly unattested
// rather than quietly unbadged.
//
// This file is pure + one fetch. No spend ledger, no API key: the report is
// public and free. Verifying the Intel/NVIDIA signature chains to their roots is
// a later step; capturing and surfacing the signed report is the quick win.

import { createHash } from "node:crypto";
import { originOf } from "./redact-url.mjs";

// The only origin that issues TEE attestations. Attestation is a NEAR AI Cloud
// capability; every other provider (boundless, lyber, a custom gateway) has
// none, so a run on them can never be "verified".
export const ATTESTING_ORIGIN = "https://cloud-api.near.ai";

// Whether this provider's gateway can attest at all. Compared the way the server
// compares origins (scheme+host+port), so a look-alike host does not qualify.
export function attestationSupported(provider) {
  return !!provider?.baseUrl && originOf(provider.baseUrl) === ATTESTING_ORIGIN;
}

// GET the signed report for one model. Public endpoint: no key, no spend. Throws
// on a non-2xx or a transport error so the caller can fall back to "unavailable"
// without ever reading a failure as "verified".
export async function fetchAttestation(baseUrl, modelId, { timeoutMs = 20_000 } = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const url = `${base}/attestation/report?model=${encodeURIComponent(modelId)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`attestation report HTTP ${res.status} for ${modelId}`);
  return res.json();
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Pull the compact, display-worthy fields for one model out of a full report,
// plus a sha256 over the full report so the bulky original (the ~300KB report,
// most of it the H100 nvidia_payload) can be stored once, content-addressed, and
// referenced by the receipt. Returns null when the report carries no attestation
// for this model (so the caller downgrades to "unavailable", never "verified").
export function summarizeAttestation(report, modelId) {
  const list = Array.isArray(report?.model_attestations) ? report.model_attestations : [];
  const m = list.find((x) => x?.model_name === modelId) || list[0];
  if (!m) return null;
  const info = m.info ?? {};
  return {
    modelName: m.model_name ?? modelId,
    signingAddress: m.signing_address ?? null, // the enclave's ed25519 identity
    composeHash: info.compose_hash ?? null, // the exact software stack that ran
    osImageHash: info.os_image_hash ?? null,
    mrAggregated: info.mr_aggregated ?? null,
    requestNonce: m.request_nonce ?? null,
    hasIntelQuote: typeof m.intel_quote === "string" && m.intel_quote.length > 0,
    hasNvidiaPayload: typeof m.nvidia_payload === "string" && m.nvidia_payload.length > 0,
    reportSha256: sha256(JSON.stringify(report)),
  };
}

// Provenance states. "verified" is the ONLY green state. Everything else is a
// deliberate, visible downgrade so an unattested run never looks as trustworthy
// as an attested one:
//   verified    — NEAR TEE run, a report with an enclave identity was captured.
//   unattested  — the provider cannot attest at all (a non-NEAR model). Feel bad.
//   unavailable — NEAR TEE run, but the report could not be fetched/parsed. A
//                 real NEAR run is not punished as hard as choosing a non-TEE one.
export function attestationState(provider, summary) {
  if (!attestationSupported(provider)) return "unattested";
  if (summary && summary.signingAddress) return "verified";
  return "unavailable";
}

// ---- In-process cache. The report is near-static per enclave deployment and
// public, so one fetch serves every run until the process restarts. persistRun
// is synchronous and must never block run-settle on a 20s network call, so a run
// start primes the cache in the background and persistRun reads it synchronously.
const summaryCache = new Map(); // key -> summary | null  (null = fetch failed)
const inflight = new Map(); // key -> Promise<summary | null> (one shared fetch)

function cacheKey(baseUrl, modelId) {
  return `${originOf(baseUrl)}|${modelId}`;
}

// The summary already in the cache for this provider+model, or null when none is
// cached yet (or the last fetch failed). Pure + synchronous: safe inside persistRun.
export function cachedSummary(provider, modelId) {
  if (!attestationSupported(provider)) return null;
  return summaryCache.get(cacheKey(provider.baseUrl, modelId)) ?? null;
}

// Fetch + summarize once, memoized. Concurrent callers share one in-flight fetch.
// A failure caches null (so the badge shows "unavailable", never "verified") and
// is retried on the next process. Resolves to the summary or null; never throws.
export async function loadSummary(provider, modelId, opts) {
  if (!attestationSupported(provider)) return null;
  const key = cacheKey(provider.baseUrl, modelId);
  if (summaryCache.has(key)) return summaryCache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const p = fetchAttestation(provider.baseUrl, modelId, opts)
    .then((report) => summarizeAttestation(report, modelId))
    .catch(() => null)
    .then((sum) => {
      summaryCache.set(key, sum);
      inflight.delete(key);
      return sum;
    });
  inflight.set(key, p);
  return p;
}

// Fire-and-forget warm for a run's models at start, so the summary is cached by
// the time the run settles. No-op for a provider that cannot attest.
export function primeAttestation(provider, modelIds = []) {
  if (!attestationSupported(provider)) return;
  for (const id of modelIds) void loadSummary(provider, id).catch(() => {});
}

// Build the receipt a run record carries. Synchronous: reads only the cache, so
// it never blocks persistRun. `modelIds` are the raw model ids the run used.
// State is the worst case across them: "verified" only when the provider can
// attest AND a summary was captured for a model the run used; "unattested" when
// the provider cannot attest at all; "unavailable" for a NEAR run whose report
// was not cached in time (a cold first run) — a background fill then patches it.
export function runAttestation(provider, modelIds = []) {
  const models = [];
  for (const id of modelIds) {
    const sum = cachedSummary(provider, id);
    if (sum) models.push(sum);
  }
  const state = attestationState(provider, models[0] ?? null);
  return { state, provider: provider?.id ?? null, models, fetchedAt: Date.now() };
}

// One place owns the badge copy + tone so the console and any report renderer
// never drift. Tone names match the UI's success/warning/neutral palette.
export const ATTESTATION_BADGE = {
  verified: {
    tone: "success",
    label: "Verified NEAR TEE",
    blurb: "Produced by an attested model inside an Intel TDX + NVIDIA H100 enclave. The exact model and the software that ran are proven unmodified.",
  },
  unattested: {
    tone: "warning",
    label: "Unattested model",
    blurb: "No hardware attestation. This provider cannot prove which model ran or that its output was untampered.",
  },
  unavailable: {
    tone: "neutral",
    label: "Attestation unavailable",
    blurb: "A NEAR TEE run, but its attestation report could not be fetched. Not proof of tampering — just unverified this time.",
  },
};
