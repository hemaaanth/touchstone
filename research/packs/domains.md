# Domains and front end (M2): OSS survey

## Scope today

Read from [`spike/packs/domains/pack.mjs`](../../spike/packs/domains/pack.mjs),
`SKILL.md` and `TOOLS.md`.

- Tier P. Proof kind `evidence`. It reads an operator-pinned DNS and front-end
  snapshot. It never runs front-end code, signs, or changes a DNS record.
- Wrapped today: dnsx, httpx, CSP Evaluator and Retire.js, plus our own checks
  (dangling CNAME, SRI, and a bundle check for signing or approval APIs).
- Read only: dnsReaper, Nuclei takeover templates and MDN HTTP Observatory.
  Hosted front-end monitors are named but not used.
- Missing registry-lock, DNSSEC and content-pin evidence is reported as an
  information gap, not as a disabled control.

## Leading OSS tools

Licenses were read from each repository's LICENSE file on 2026-11-10. See the
[method](README.md#method).

| Tool | What it does | License | Use mode | Coverage | Crypto gap |
|---|---|---|---|---|---|
| [openrdap](https://github.com/openrdap/rdap) | RDAP client. It returns registrar, EPP status codes, name servers and dates as JSON. | [MIT](https://github.com/openrdap/rdap/blob/HEAD/LICENSE) | lift | Registry lock evidence (`server*Prohibited` statuses), `client*Prohibited` statuses, registrar, name-server changes, expiry. Uses the [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json). | Does not say which registrar features (MFA, account lock) are on. Those live in the registrar account. |
| [checkdmarc](https://github.com/domainaware/checkdmarc) | Checks SPF, DMARC, MX, STARTTLS, BIMI, MTA-STS and DNSSEC. | [Apache-2.0](https://github.com/domainaware/checkdmarc/blob/HEAD/LICENSE) | lift | Mail spoofing posture and a DNSSEC yes or no. JSON output. | Generic. A spoofed mail from the team's domain is a common wallet lure, but the tool does not rank by that. |
| [Zonemaster engine](https://github.com/zonemaster/zonemaster-engine) | Full DNS delegation and DNSSEC test suite. | [BSD-2-Clause style](https://github.com/zonemaster/zonemaster-engine/blob/HEAD/LICENSE) | lift | Delegation, name-server consistency, DNSSEC chain. | Generic. |
| [DNSViz](https://github.com/dnsviz/dnsviz) | DNSSEC analysis and graphs. | [GPL-2.0](https://github.com/dnsviz/dnsviz/blob/HEAD/LICENSE) | shell out | The deepest DNSSEC chain analysis. | Generic. |
| [dnsx](https://github.com/projectdiscovery/dnsx) and [httpx](https://github.com/projectdiscovery/httpx) | Resolver and HTTP prober. Wrapped today. | MIT ([dnsx](https://github.com/projectdiscovery/dnsx/blob/HEAD/LICENSE.md), [httpx](https://github.com/projectdiscovery/httpx/blob/HEAD/LICENSE.md)) | lift | Raw records and responses for the snapshot. | None specific. |
| [CSP Evaluator](https://github.com/google/csp-evaluator) | Rates a Content-Security-Policy. Wrapped today. | [Apache-2.0](https://github.com/google/csp-evaluator/blob/HEAD/LICENSE) | lift | Unsafe sources, missing directives, bypassable allowlists. | Does not know which script origins the team approved. |
| [Retire.js](https://github.com/RetireJS/retire.js) | Finds known-vulnerable JS libraries in served code. Wrapped today. | [Apache-2.0](https://github.com/RetireJS/retire.js/blob/HEAD/LICENSE.md) | lift | Served JS that is not in a manifest. | No wallet SDK advisories unless someone files them. |
| [MDN HTTP Observatory](https://github.com/mdn/mdn-http-observatory) | Scores HTTP security headers. | [MPL-2.0](https://github.com/mdn/mdn-http-observatory/blob/HEAD/LICENSE) | shell out (read only today) | CSP, HSTS, SRI, cookies, redirects. | Generic. |
| [can-i-take-over-xyz](https://github.com/EdOverflow/can-i-take-over-xyz) | Community list of takeover-prone services and fingerprints. | [CC-BY-4.0](https://github.com/EdOverflow/can-i-take-over-xyz/blob/HEAD/LICENSE) | lift (data, attribution) | [fingerprints.json](https://raw.githubusercontent.com/EdOverflow/can-i-take-over-xyz/master/fingerprints.json) marks each service vulnerable or not. | Not tied to dapp hosts such as IPFS gateways, Fleek or Vercel previews. |
| [dnsReaper](https://github.com/punk-security/dnsReaper) | Subdomain takeover scanner. | [AGPL-3.0](https://github.com/punk-security/dnsReaper/blob/HEAD/LICENSE) | shell out (read only today) | About 50 provider signatures. | Same as above. |
| [subjack](https://github.com/haccer/subjack) | Subdomain takeover checker. | [MIT](https://github.com/haccer/subjack/blob/HEAD/LICENSE) | lift | A permissive fingerprint set. Less active. | Same as above. |
| [subzy](https://github.com/PentestPad/subzy) | Takeover checker based on can-i-take-over-xyz. | [GPL-2.0](https://github.com/PentestPad/subzy/blob/HEAD/LICENSE) | skip | Covered by the CC-BY data directly. | Same as above. |
| [testssl.sh](https://github.com/testssl/testssl.sh) | TLS configuration test. | [GPL-2.0](https://github.com/testssl/testssl.sh/blob/HEAD/LICENSE) | shell out | Protocols, ciphers, certificate chain, known TLS bugs. | Generic. |
| [SSLyze](https://github.com/nabla-c0d3/sslyze) | TLS scanner as a Python library. | [AGPL-3.0](https://github.com/nabla-c0d3/sslyze/blob/HEAD/LICENSE.txt) | shell out | Same area as testssl.sh. | Generic. |
| [ssllabs-scan](https://github.com/ssllabs/ssllabs-scan) | Client for the hosted SSL Labs API. | [Apache-2.0](https://github.com/ssllabs/ssllabs-scan/blob/HEAD/LICENSE) | read only | Hosted grading. Not offline. | Generic. |
| [webappanalyzer](https://github.com/enthec/webappanalyzer) | Maintained fork of the Wappalyzer technology fingerprints. | [GPL-3.0](https://github.com/enthec/webappanalyzer/blob/HEAD/LICENSE) | shell out (fetch and pin data) | Framework, CDN and hosting detection. | Few wallet library fingerprints. |

Hosted front-end monitors (Cloudflare Page Shield, cside, Hypernative,
Blockaid, Front Sentinel) are already listed in `TOOLS.md` as read only.

## Recommendation

1. **Wrap openrdap.** It turns "registry lock evidence is missing" into a real
   check. The `serverTransferProhibited`, `serverUpdateProhibited` and
   `serverDeleteProhibited` EPP statuses show a registry lock. A name-server or
   registrar change between two snapshots is a high-severity lead. The output
   is JSON, so the evidence replay can pin it.
2. **Wrap checkdmarc.** It answers the DNSSEC question and adds SPF and DMARC.
   Both are Apache-2.0 or MIT, so the parsers can be lifted.
3. Next: lift can-i-take-over-xyz's fingerprints into our dangling-CNAME check
   with attribution. Run testssl.sh as a separate program for TLS.

## Biggest crypto gap

**No tool compares the live dapp bundle with an approved list of contract
addresses and script origins.** CSP, SRI and header tools grade policy. They
do not know that the router address in the served JS changed, or that a new
script origin appeared. In July 2024, attackers took over DeFi domains moved
from Google Domains to Squarespace with MFA off. They pointed Compound, Celer
and Pendle front ends at a drainer
([Hackread](https://hackread.com/defi-hack-alert-squarespace-domains-dns-hijacking/),
[SC World](https://www.scworld.com/brief/squarespace-registered-defi-platforms-subjected-to-dns-hijacking)).
The drainer kit is described in
[Group-IB's Inferno Drainer report](https://www.group-ib.com/blog/inferno-drainer/).
Touchstone can pin an approved manifest of addresses, chain IDs, RPC hosts and
script origins with their hashes. It then diffs each new snapshot against it.
Our bundle check already finds approval APIs, so this is a small step.

Registrar posture is the second gap. No OSS tool reads it, so openrdap's EPP
status is the best evidence we can get without registrar access.

## Feeds

| Feed | What it gives | URL | Terms or note |
|---|---|---|---|
| IANA RDAP bootstrap | Which RDAP server serves each TLD | <https://data.iana.org/rdap/dns.json> | Public. [ICANN RDAP](https://www.icann.org/rdap). |
| Public Suffix List | Registrable domain boundaries | <https://publicsuffix.org/list/public_suffix_list.dat> | MPL-2.0 data. Fetch and pin. |
| HSTS preload list | Is the domain preloaded | <https://hstspreload.org/api/v2/status?domain=example.com> | Public API. |
| can-i-take-over-xyz | Takeover fingerprints | [fingerprints.json](https://raw.githubusercontent.com/EdOverflow/can-i-take-over-xyz/master/fingerprints.json) | [CC-BY-4.0](https://github.com/EdOverflow/can-i-take-over-xyz/blob/HEAD/LICENSE) |
| Certificate Transparency | Unexpected certificates for the team's names | <https://crt.sh/?q=example.com&output=json> | A new certificate from an unknown CA is an early hijack sign. |
| Retire.js repository | Vulnerable JS library data | <https://raw.githubusercontent.com/RetireJS/retire.js/master/repository/jsrepository-v4.json> | [Apache-2.0](https://github.com/RetireJS/retire.js/blob/HEAD/LICENSE.md). Pinned today. |
| Phishing and drainer feeds | Known drainer hosts loaded by a bundle | See [people-brand.md](people-brand.md#feeds). | |
