# Spike

Engine tests live in `test/` and run with:

```sh
npm test
```

That runs `test/*.test.mjs`. A directory passed to `node --test` is not a test file on Node 22, so the script names the files. Before the run it removes leftover Docker networks whose names belong to this harness (`touchstone-reach-client-`, `touchstone-inner-`, and the other prefixes in `lib/docker-nets.mjs`). It does not remove `bridge`, `host`, `none`, or any other network.

## Docker

Tests that need Docker or a scanner image skip, with the missing piece named, when it is not there. To run them:

```sh
spike/scripts/setup-docker
```

The script installs Docker (`docker.io` and the BuildKit plugin via apt, or get.docker.com if apt is not available), starts `dockerd` when the daemon is not already up, and pulls or builds the images the suite inspects: Foundry, `node:20-slim`, the supply-chain scanners, Trivy, KICS, moto, the domains tools image, jsluice, the chain-tools image, Aderyn, and the web / AI-MCP labs. It also fills the `foundry-svm` volume with solc 0.8.20 and 0.8.38 so later `forge test --offline` runs do not try to download a compiler. garak is large; add it with `spike/scripts/setup-docker --garak`.

The first build needs network. Later scans do not. If an older iptables table is still loaded with a DROP policy on forwarding, the script accepts that traffic so containers on a harness network can reach each other.
