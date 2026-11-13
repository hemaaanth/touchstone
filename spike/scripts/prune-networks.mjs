// Drop harness networks left behind by an earlier run, before the suite
// allocates more. Only names in lib/docker-nets.mjs are eligible. Docker
// being absent is not a failure: the suite skips the tests that need it.
import { pruneOwnedNetworks } from "../lib/docker-nets.mjs";

const result = await pruneOwnedNetworks({ containers: true });
if (!result.ok) {
  console.error(`harness network prune skipped: ${result.reason}`);
} else if (result.removed.length || result.containers.length) {
  if (result.containers.length) console.error(`removed leftover harness containers: ${result.containers.join(" ")}`);
  if (result.removed.length) console.error(`removed leftover harness networks: ${result.removed.join(" ")}`);
}
