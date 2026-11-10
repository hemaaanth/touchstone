# Red-team harness (working name)

Status: concept. Not final. Second project from the same lead: issue-tipjar (Q-015 disclosure).

Decisions of Nov 8 are in [research/harness/sections/08-proposed-ui.md §12](research/harness/sections/08-proposed-ui.md#12-decisions-nov-8). Where this file disagrees, the spec wins.

## One line
A security web app that runs 24/7, locally or self-hosted, and keeps attacking its user's own code and infrastructure. Every run happens in a sandbox. The AI is NEAR AI's abliterated models.

## Problem
Most small teams never pen-test. Audits are slow, costly, and one-off. Attackers now use AI and scan all the time. Defenders do not.

## What it does (user's concept)
- Reads the code (when given access) and looks for vulnerabilities.
- Red-teams the running system.
- Checks the outside surface: domain and DNS setup, TLS, open ports, weak or default passwords on servers.
- Watches live CVE feeds (for example NVD, CISA KEV) and matches them against the team's stack in real time.
- Runs as a web app, locally or self-hosted. No desktop app, no Tauri, no Electron, no tray (decision 1).
- Every run happens in a sandbox, never on the host. MVP: local Docker plus gVisor (runsc). Agents think on the host and act in sandboxes (decision 2).
- The user wants "abliterated" models (models with refusals removed) so the AI does not refuse offensive security work. All roles, the judge included, use NEAR AI's abliterated models (decision 6).

## NEAR role
- NEAR AI Cloud runs every AI role through its OpenAI-compatible API. The NEAR AI key stays on the host. A PII strip list runs before any prompt leaves (decision 7).
- No TEE, no attestation check and no "Verified" chips in the harness. Each run keeps `models.json` and shows "Models used" (decision 5).
- Answered: NEAR AI Cloud offers abliterated models (see the update below).
- Dropped: signed findings and on-chain scan receipts. The grant needs no wallet and no signature (decision 3).

## Tracks (draft)
security (crowded with agent spend firewalls, but no continuous pen-test harness found on 2026-11-06), privacy.

## Closest submissions seen (scout, 2026-11-06; unverified, no scout notes in the repo)
Sealed Exploit (TEE-run exploit bounties), Skarbnik (private repair bounties, zk proof), Redline (sealed disclosure). None is a continuous self-hosted pen-test harness.

## Open questions
- Scope for 8 days: which 2-3 checks make the demo?
- Legal and safety: only scan assets the user owns. Answered: a versioned grant, confirmed by typing the project name, plus a no-wallet ownership proof (DNS TXT, a known-path file, or a repo file or deploy artifact). Fork tests need no proof (decision 3).
- What runs where? Answered: the web app, the agent loop and the NEAR AI key stay on the host. Every run happens in a sandbox. Model calls go to NEAR AI Cloud (decision 2).

## Update 2026-11-06 (verified on near.ai/red)
- Model question answered. NEAR AI Cloud serves abliterated models, open to every account, no application. NEAR hosts them in its Private TEE tier, but the harness does not rely on that (decision 5). Context sizes and prices below are from [07 gap 1](research/harness/sections/07-gap-1.md):
  - `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated` (1.05M context, $0.3 / $1.2 per 1M tokens in/out)
  - `Qwen/Qwen3.8-27B-abliterated` (262K context, $0.04 / $1.35)
  - The API is OpenAI-compatible, so switching to it only needs a new base URL.
- NEAR AI RED (launched 2026-10-29) is an optional program for security teams. New members get 20% off their first month. Early access and support are unverified. Its terms: lawful use only, on systems you own or have written permission to test. Our "only scan what you own" guard matches this.
- NEAR AI's own pitch is "find the vulnerabilities in your code before attackers do" (unverified quote, not in the repo). We are the always-on harness built on top of it, not a competing model.
- Prior art to borrow (scout, unverified): Sealed Exploit's real-vs-fake numbers, AgentGauntlet's evidence bundle per run. TEE Receipts (attestation plus an on-chain signature check) is dropped by decisions 3 and 5.
