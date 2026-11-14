// Import this FIRST in a test that loads lib/grant-store.mjs or
// lib/scopes-store.mjs, even through other modules:
//
//   import "./helpers/isolated-env.mjs";
//
// grant-store reads (or creates) the console token when it loads, and the
// stores read grants.json and scopes.json under spike/data. In the main
// checkout those are the operator's real token, grants and scopes. Static
// imports run before any line of the test body, so setting env in the body is
// too late; a first import is not. This points all of them at a throwaway
// directory, removed when the process exits. A test that needs its own values
// sets them after this import (the stores read the file env on each call).
// The guard test (test-isolation.test.mjs) fails a test that forgets this.
// It also points lib/providers.mjs (the saved provider config) at that directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "touchstone-test-store-"));
process.env.TOUCHSTONE_GRANT_TOKEN = "test-grant-token";
process.env.TOUCHSTONE_GRANT_TOKEN_FILE = join(dir, "console-token");
process.env.TOUCHSTONE_GRANTS_FILE = join(dir, "grants.json");
process.env.TOUCHSTONE_SCOPES_FILE = join(dir, "scopes.json");
process.env.TOUCHSTONE_PROVIDERS_FILE = join(dir, "providers.json");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

export const TEST_STORE_DIR = dir;
