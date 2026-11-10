# Third-party code

One line per piece of open-source code, rules or prompts we copied or adapted.
Tools we only run as separate programs are listed in each pack's TOOLS.md, not
here.

| What | From | License | Where in our repo |
|------|------|---------|-------------------|
| PEM private-key detector and default-rule extension workflow | [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml) | MIT; Copyright (c) 2019 Zachary Rice; notice in `LICENSE.gitleaks` | `spike/packs/supply-chain/gitleaks.toml` |
| Offline advisory GHSA-35jh-r3h4-6jhm, copied without edits and packaged as a one-record OSV npm database | [GitHub Advisory Database via OSV](https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/); GitHub Advisory Database contributors; no warranty | `spike/packs/supply-chain/advisories/` |
| Nuclei GitHub takeover template v10.1.0 (lab comparison only) | [projectdiscovery/nuclei-templates](https://github.com/projectdiscovery/nuclei-templates/blob/v10.1.0/http/takeovers/github-takeover.yaml), Copyright (c) 2020 ProjectDiscovery, Inc. | MIT; notice in domains/NOTICE | spike/packs/domains/lab/github-takeover.yaml |
| CSP parser and evaluator workflow; rules stay inside the tool image | [google/csp-evaluator](https://github.com/google/csp-evaluator), Copyright Google Inc. | Apache-2.0; upstream license stays in installed package | spike/packs/domains/analyze.mjs |
| Retire.js advisory snapshot 5.2.5, unchanged | [RetireJS/retire.js](https://github.com/RetireJS/retire.js/tree/5.2.5), Copyright Retire.js contributors | Apache-2.0; upstream license stays in installed package | Built into the domains tool image by spike/packs/domains/Dockerfile |
| forge-std (test library, vendored) | https://github.com/foundry-rs/forge-std | MIT or Apache-2.0 | `spike/packs/keys/lab/lib/forge-std/` |
| forge-std (test library, vendored) | https://github.com/foundry-rs/forge-std | MIT or Apache-2.0 | `spike/packs/chain-watch/lab/lib/forge-std/` |
