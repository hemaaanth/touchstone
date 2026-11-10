# Third-party code

One line per piece of open-source code, rules or prompts we copied or adapted.
Tools we only run as separate programs are listed in each pack's TOOLS.md, not
here.

| What | From | License | Where in our repo |
|------|------|---------|-------------------|
| PEM private-key detector and default-rule extension workflow | [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml) | MIT; Copyright (c) 2019 Zachary Rice; notice in `LICENSE.gitleaks` | `spike/packs/supply-chain/gitleaks.toml` |
| Offline advisory GHSA-35jh-r3h4-6jhm, copied without edits and packaged as a one-record OSV npm database | [GitHub Advisory Database via OSV](https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/); GitHub Advisory Database contributors; no warranty | `spike/packs/supply-chain/advisories/` |
