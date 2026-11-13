// Stored tool output. The snapshot keeps each tool's output text and its
// sha256. Leads re-parse that text every time; a stored verdict is never read.
import { readFileSync } from 'node:fs';
import { sha256 } from '../../lib/proof-evidence.mjs';

export const storedRecord = output => ({ raw: sha256(output), output });

// A tool's output file as text. raw must be the hash of the file bytes, so a
// file that is not exact UTF-8 is refused instead of silently changed.
export function readOutputFile(path) {
  const bytes = readFileSync(path);
  const output = bytes.toString('utf8');
  if (!Buffer.from(output, 'utf8').equals(bytes)) throw new Error('output file is not UTF-8');
  return output;
}

// { evidence } when the stored output matches its hash and parses, else { error }.
export function readStored(entry, parse) {
  if (!entry || typeof entry !== 'object') return { error: 'not a stored tool output' };
  if (typeof entry.raw !== 'string' || !/^[0-9a-f]{64}$/.test(entry.raw)) return { error: 'no tool output hash' };
  if (typeof entry.output !== 'string') return { error: 'no stored tool output' };
  if (sha256(entry.output) !== entry.raw) return { error: 'the stored tool output does not match its sha256' };
  try { return { evidence: parse(entry.output) }; }
  catch (error) { return { error: 'the stored tool output does not parse: ' + String(error?.message ?? error).slice(0, 160) }; }
}
