// Backwards-compatibility shim. The inference client became provider-agnostic
// (NEAR is now just one provider among several — see providers.mjs). Existing
// callers that import "./near.mjs" keep working; they drive whichever provider
// PROVIDER selects. Prefer importing "./inference.mjs" in new code.
export * from "./inference.mjs";
