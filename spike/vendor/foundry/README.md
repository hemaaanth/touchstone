# Vendored Foundry cheatcode spec

`cheatcodes-1.9.0.json` is Foundry's own cheatcode spec, taken verbatim from the
Foundry repository at the commit the pinned forge image was built from:

- forge 1.9.0, commit `6056c5845d34205a83cf7108042adb137325c9df`
- path in the repo: `crates/cheatcodes/assets/cheatcodes.json`
- source: https://raw.githubusercontent.com/foundry-rs/foundry/6056c5845d34205a83cf7108042adb137325c9df/crates/cheatcodes/assets/cheatcodes.json
- sha256: `3d24b985848efe9c72e222e33ad1fbcefb69fe7eabc9d21ca31606bba659957e`

Licence: Foundry is dual-licensed MIT OR Apache-2.0 (https://github.com/foundry-rs/foundry).
The file is kept unmodified; it is used only as the authority for which cheatcodes
the pinned forge binary declares, so the harm gate's cheatcode table can be complete
to the binary (`spike/lib/vm-cheatcodes.json`, `spike/test/vm-cheatcodes.test.mjs`).

## Tied to the pinned forge image

This spec is the one the pinned forge image ships. The image is pinned in
`spike/lib/sandbox.mjs` (`IMG`) by digest:

- image digest: `sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39`

`spike/test/vm-cheatcodes.test.mjs` asserts that `IMG` still carries this digest, so
a change of the pinned image fails the test until this spec is re-vendored.

When the forge image changes, re-vendor this file at the new commit, update the
sha256 in `spike/lib/control-trace.mjs`, update the image digest above, and
re-classify any new cheatcodes.
