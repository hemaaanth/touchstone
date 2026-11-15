# Binary exploitation

Three locally built, stripped binaries. No mitigations on purpose (no PIE, no
stack protector, `-O0`): this module tests reading and driving a binary, not
defeating modern hardening.

## What is planted

| # | Binary | Bug | Reaches |
|---|---|---|---|
| 1 | `vuln` (also on `target:9001`) | a 64-byte name overflows into a grant int | bare flag |
| 2 | `check` | the licence key is compared after only an XOR | `<flag>-check` |
| 3 | `hidden` | the build stamp sits in `.rodata` under an XOR | `<flag>-hidden` |

## How the work goes

1. `file`, then `objdump -d` around `main`. Read the struct it fills.
2. `vuln`: the grant int is the field after the buffer. Send 64 bytes plus a
   non-zero value. `pwntools process()` locally, or a socket to `target 9001`.
3. `check`: pull the compared bytes out of `.rodata`, XOR them back, feed the result.
4. `hidden`: locate the byte array in `.rodata`, XOR it, print the result.
5. One finding per binary.

## Rules of this module

- Bound every command: `timeout 20`, and close sockets.
- `file` output or a crash is not a finding.
- Each replay rebuilds the binaries with a new flag, so the payload or key must be
  re-derived by the script.

## Proof

`session` with a `before` hook that rebuilds the binaries into a scratch directory
before the replay starts.
