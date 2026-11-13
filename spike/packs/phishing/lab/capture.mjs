// Operator script. It captures the lab once and pins lab/snapshot.json.
// Run from spike/: node packs/phishing/lab/capture.mjs
// It needs Docker, the local dnstwist image and the CoreDNS image. Tests never run it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startLab, LAB, toCanonSnapshot } from '../labctl.mjs';
import { captureLookalikes } from '../live.mjs';
import { pinSnapshot } from '../../../lib/proof-evidence.mjs';

const cfg = JSON.parse(readFileSync(join(LAB, '.touchstone.json'), 'utf8'));
const lab = await startLab();
try {
  await sleep(1500);
  const snapshot = await captureLookalikes({ ws: LAB, domain: cfg.domain, owned: cfg.owned, reach: lab, blocklists: cfg.blocklists, lab: true });
  if (snapshot.coverage[0].status !== 'ran') throw new Error('Capture failed: ' + snapshot.coverage[0].reason);
  // Pin the canonical resolver address, not this run's own (each run has its own subnet).
  console.log('rows', snapshot.dnstwist.rows.length, 'hash', pinSnapshot(LAB, toCanonSnapshot(snapshot, lab)));
} finally { await lab.stop(); }
