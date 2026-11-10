# People and brand: tool choices

Scope: M15 and M16 in the harness research. This pack accepts a made-up .test
lab only. Every scanner uses runTool() with network none. It makes no live DNS,
certificate, social, GitHub, npm, or HTTP requests. Image builds download tools.

## Integration matrix

Sizes below are local Docker image sizes in decimal MB. They are not downloads.

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Crypto gap | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [dnstwist 20250130](https://github.com/elceef/dnstwist/tree/20250130) | Apache-2.0 | touchstone-people-dnstwist:20250130; 189.6 MB; Dockerfile.dnstwist | Yes. --format list generates names without DNS. | Approved .test domains | One name per line | impersonation-domain at an observed DNS, certificate, or page host | evidence; regenerate names and correlate the pinned records | URLCrazy; lab result below | No source copied. Its permutation engine stays in Docker. | No account, copied dapp, address, or WalletConnect checks | ensemble with confusables; works on .test and finds transpositions |
| [URLCrazy 0.8.2](https://github.com/urbanadventurer/urlcrazy/tree/78bf6e855d6d83e387ae3b5c8ffc36f241b96f66) | Custom restricted license in urlcrazy header. Commercial domain-protection services need permission. Penetration-testing exception. Not permissive. | Comparison only: touchstone-people-permutations:wave2; 710.9 MB | -r disables DNS; -i includes invalid generated names. The input validator still rejects .test. | astralharbor.test | -f json requested; exits 1 before output | None on this lab | No passing evidence from this tool | Compared directly with dnstwist | No code copied or patched | Same crypto gaps as dnstwist | read only; rejected .test and has service-use limits. Not called by the pack. |
| [eth-phishing-detect 1.2.0](https://www.npmjs.com/package/eth-phishing-detect) and [MetaMask feed](https://github.com/MetaMask/eth-phishing-detect/blob/8402334d5d506e9e303bf50b7785a56cfaaf5ccb/src/config.json) | Engine: DBAD 1.1, custom. Feed: DBAD 1.2, custom. Not MIT or an OSI license. Both notices retained. | touchstone-people-analysis:wave2; 238.5 MB; locked npm install | Yes. Constructor receives pinned lists. It never fetches a feed. | Captured hosts and feed subsets | JSON from the real Detector.check() | blocklist-match signal grouped with the host | evidence; repeat exact and parent-label matching with allowlist precedence | MetaMask and eth-phishing-detect are one family, not independent detections | 32 blocklist and 8 allowlist entries from the pinned MetaMask commit; THIRD_PARTY.md | Does not detect address swaps, claim pages, or support impersonation | ensemble; use the real matcher, not a replacement |
| [BlocklistProject phishing list](https://github.com/blocklistproject/Lists) | Data header says MIT. Repository root says Unlicense. Both original statements retained; upstream inconsistency disclosed. | Data consumed by the same analysis image | Yes. 32 records from a captured 80-line excerpt. Content hash recorded in snapshot. | Pinned domain list | Same Detector.check() JSON | A named feed match, not a separate duplicate finding | evidence; match the pinned data, not today's live feed | Same matcher; independent data source | Captured source excerpt and selected records; THIRD_PARTY.md | Does not establish a relationship to the brand | ensemble; no live refresh and no claim of full-list coverage |
| [Legitify](https://github.com/Legit-Labs/legitify/tree/038aa49473a6974a3ef79f6c76b949b689d23282) CLI | Apache-2.0 | CLI not run. Its rules are evaluated below. | CLI analyze uses authenticated GitHub or GitLab APIs. No saved-JSON analyze mode found. | API-backed organization collection | CLI report | No CLI leads in this pack | Not applicable | Original rules below provide offline posture checks | Unchanged organization.rego and common helpers, Apache-2.0; NOTICE.legitify | Does not inspect crypto front ends or published addresses | read only for CLI; no credentials or API calls |
| [OPA 0.63.0](https://github.com/open-policy-agent/opa/tree/v0.63.0) with original Legitify rules | Apache-2.0 | openpolicyagent/opa:0.63.0-static pinned by sha256:b181f9f31a5544870a96ae69ad3613d8d07f7757c4ab32f774bd4e9f4cb305d9; 65.5 MB | Yes. Rules and input are mounted locally. | Pinned GitHub organization JSON export | eval --format json | github-two-factor-not-required; github-public-repo-creation; github-default-permissions | evidence; replay the original rules on explicit, typed fields for the approved organization | Legitify's online collection is not needed | Three policy results selected from the unchanged rule module | No social 2FA inference. No transaction, wallet, or brand analysis. | wrap; rules work without GitHub access |
| [confusables 1.1.1](https://github.com/gc/confusables), [parse5 7.2.1](https://github.com/inikulin/parse5), [Acorn 8.14.0](https://github.com/acornjs/acorn) | MIT for each installed package | Same locked analysis image | Yes. Node X509Certificate also parses captured certificate PEM. | Pinned handles, HTML, JavaScript, and certificates | JSON | Unicode lookalikes, claimed identities, links, captured configuration | evidence; repeat parsing and registry comparison | Confusables fills the observed Unicode miss in dnstwist | No parser source copied. No page code executed. | Our checks add grouped clone, WalletConnect, claim, and address signals | ensemble; use maintained parsers and Unicode mappings |

## Offline comparison

validation/permutations.json records the actual commands and results.
Both tools ran in Docker through runTool(), with no network.

- dnstwist generated 9,366 candidates for astralharbor.test.
- It found astralharb0r.test and the transposition astralharbro.test.
- It did not generate xn--astralhrbor-4ij.test. This is astralhаrbor.test with a Cyrillic a.
- Confusables and the captured certificate SAN found that host.
- URLCrazy exited 1: Aborting. Invalid domainname. No JSON result was produced.
- We did not patch URLCrazy or replace .test with a public target.

The selected tools are complementary. There is no need to run the restricted
comparison image during a pack run. Runtime images and package licenses are
recorded in validation/packages.json and the pinned build recipes.

## Pinned data and licenses

MetaMask's source commit is 8402334d5d506e9e303bf50b7785a56cfaaf5ccb.
The installed npm engine has DBAD 1.1. The feed commit has DBAD 1.2.
They are different versions of a custom license. Neither is labeled MIT here.

The BlocklistProject copy is pinned by content, not by a moving main branch.
The snapshot records the source-excerpt SHA-256. The raw excerpt is stored in
lab/blocklistproject-source.txt. The file header says MIT. Its root LICENSE is
Unlicense. NOTICE.blocklistproject preserves both statements.

These are bounded lab fixtures, not full or current feeds. No public feed
contains our made-up .test names. A separate, clearly labeled synthetic lab
list matches astralharb0r.test. This is never reported as a vendor detection.
The real engine is also tested against a pinned public entry, parent-label
matches, deceptive suffixes, and allowlist precedence. No domain is visited.

## Our crypto checks

- A copied page has the same tag sequence and DOM text as an approved page.
  A contract or spender literal outside the role's approved addresses adds a
  high-severity signal. This does not execute the configuration.
- An off-brand WalletConnect configuration literal outside the approved ID
  registry adds a signal. A generic analytics projectId does not.
- An off-brand page that names the project and offers an unapproved claim or
  airdrop adds a signal. It is not proof that a transaction can steal funds.
- Script names seaport.js, wallet-connect.js and coinbase.js together raise a
  review-only pattern. These names were reported in [Group-IB's Inferno report](https://www.group-ib.com/blog/inferno-drainer/).
  Names alone cannot identify malware. Two published SHA-256 indicators are
  checked against actual captured bundle bytes. No malware was downloaded.
- A published address with the same first six and last four hex digits as an
  approved address, but a different middle, raises an address-poisoning risk.
  Exact matches are compared without case. No transfer or chain lookup occurs.

One host is one finding. Its signals are grouped. A fake account, a published
link, an organization setting and a poisoned document are separate fixes.
The proof establishes captured facts and registry differences. It does not
establish an account owner's intent, domain control, a working drainer, or loss.

## Limits

No people are searched or contacted. No social API is called. No phishing
simulation runs. No messages, signing requests, claims or transactions are sent.
Social 2FA remains unknown. GitHub policy checks require explicit typed fields
for the approved organization. Missing, malformed or foreign exports are not
reported as disabled controls.

A brand mention in an article is not enough to establish impersonation.
Without a lookalike name, a page must have a copied layout and brand text, or
an explicit official, claim or airdrop title with brand text. An official-link
check requires the word official or an HTML rel=me ownership claim. A generic
GitHub source citation is not an official destination. These guards have
real-parser regression tests.

Passive findings do not prove domain availability. Do not recommend claiming
or registering an observed host. Use ownership review and authorized takedown
procedures. A recovery phrase must never be shared with any support contact.

JavaScript analysis covers captured string literals in object properties.
Obfuscated, computed and dynamically loaded configuration can be missed.
The lab has one inert captured script body. Two other script names have no
captured bodies. They remain filename indicators only. No external script is
fetched. Certificate matches prove a captured SAN, not current issuance,
validity, ownership or live DNS. A generated name without a captured DNS answer,
certificate or page cannot become a finding.
