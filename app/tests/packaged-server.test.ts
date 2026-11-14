// Source/fake checks plus real Vite on a synthetic sealed fixture, without a listener.
// Never import the real backend, load dotenv, or read operator stores.
import "./helpers/isolated-env"
import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
// @ts-expect-error — plain .mjs module
import { releaseConfig, startServer } from "../server/start.mjs"

const dir = mkdtempSync(join(tmpdir(), "release-launcher-"))
const env = { TOUCHSTONE_VITE_CACHE_DIR: join(dir, "cache", "vite") }
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("default launcher stays on loopback with a fixed port and no watcher or HMR", () => {
  const config = releaseConfig(env)
  expect(config.server).toEqual({ host: "127.0.0.1", port: 5190, strictPort: true, hmr: false, open: false })
  expect(config.root).toBe(fileURLToPath(new URL("../", import.meta.url)))
  expect(config.configFile).toBe(fileURLToPath(new URL("../vite.config.ts", import.meta.url)))
  expect(config.cacheDir).toBe(env.TOUCHSTONE_VITE_CACHE_DIR)
  expect(config.configLoader).toBe("runner")
  expect(config.plugins.map((plugin: { name: string }) => plugin.name)).toEqual(["touchstone-release-no-watch"])
})

test("no-argument config reads the launch environment and uses port/host defaults", () => {
  const keys = ["HOST", "PORT", "TOUCHSTONE_VITE_CACHE_DIR"] as const
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    delete process.env.HOST
    delete process.env.PORT
    process.env.TOUCHSTONE_VITE_CACHE_DIR = env.TOUCHSTONE_VITE_CACHE_DIR
    expect(releaseConfig()).toEqual(releaseConfig(env))
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

test("explicit loopback and port are accepted without enabling public binding", () => {
  expect(releaseConfig({ ...env, HOST: "::1", PORT: "5191" }).server).toMatchObject({ host: "::1", port: 5191 })
  for (const HOST of ["", "0.0.0.0", "::", "example.test", "127.0.0.1.example.test"]) {
    expect(() => releaseConfig({ ...env, HOST })).toThrow("loopback")
  }
})

for (const PORT of ["", "0", "-1", "65536", "1.5", "NaN", "Infinity", "5190suffix", " 5190", "5e3"]) {
  test(`invalid port ${JSON.stringify(PORT)} is refused before loading Vite`, async () => {
    let called = false
    await expect(startServer({ ...env, PORT }, async () => { called = true })).rejects.toThrow("PORT")
    expect(called).toBe(false)
  })
}

test("cache must be an explicit absolute private-state path", () => {
  for (const TOUCHSTONE_VITE_CACHE_DIR of [undefined, "", "relative/cache"]) {
    expect(() => releaseConfig({ TOUCHSTONE_VITE_CACHE_DIR })).toThrow("absolute private-state path")
  }
})

test("launcher passes the release config to Vite and starts exactly once", async () => {
  const calls: string[] = []
  const server = { listen: async () => { calls.push("listen") }, close: async () => { calls.push("close") } }
  const result = await startServer(env, async (config: unknown) => {
    calls.push("create")
    expect(config).toEqual(releaseConfig(env))
    return server
  })
  expect(result).toBe(server)
  expect(calls).toEqual(["create", "listen"])
})

test("occupied-port failure closes the Vite server and never retries another port", async () => {
  const failure = Object.assign(new Error("fixture port is occupied"), { code: "EADDRINUSE" })
  const calls: string[] = []
  await expect(startServer(env, async (config: { server: { strictPort: boolean } }) => {
    calls.push("create")
    expect(config.server.strictPort).toBe(true)
    return {
      listen: async () => { calls.push("listen"); throw failure },
      close: async () => { calls.push("close") },
    }
  })).rejects.toBe(failure)
  expect(calls).toEqual(["create", "listen", "close"])
})

test("existing Vite source retains backend dispatch, guard order, and runtime token injection", () => {
  const source = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")
  expect(source).toContain("plugins: [react(), tailwindcss(), touchstoneApi()]")
  expect(source).toMatch(/transformIndexHtml:[^\n]*ctx\.server[^\n]*consoleToken\(\)/)
  expect(source).toContain("cors: false")
  expect(source).toContain("path.resolve(import.meta.dirname, './src')")
  expect(source).not.toContain("__dirname")
  const middleware = source.slice(source.indexOf("configureServer(server)"))
  const ordered = ["foreignOrigin(req)", "startsWith('/api/')", "consoleWriteRefusal(req)",
    "handleModels(req, res)", "handleConsoleToken(req, res)", "handleRuns(req, res)",
    "handleScopes(req, res)", "handleGrants(req, res)", "handleSettings(req, res)",
    "handleFindings(req, res)", "handleApi(req.url)"]
  let previous = -1
  for (const fragment of ordered) {
    const index = middleware.indexOf(fragment)
    expect(index).toBeGreaterThan(previous)
    previous = index
  }
  expect(middleware).toContain("if (res.headersSent)")
})

test("real Vite uses the runner on a sealed fixture and keeps zero watchers after transforms", () => {
  const release = join(dir, "sealed-release")
  const cache = join(dir, "runtime-cache")
  mkdirSync(release)
  mkdirSync(cache)
  const fixtureConfig = `import path from 'node:path';
    export default {
      resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
      plugins: [{ name: 'fixture-backend',
        configureServer(server) { server.middlewares.use((_req, _res, next) => next()); },
        transformIndexHtml() { return [{ tag: 'meta', attrs: { name: 'fixture-token', content: 'synthetic-only' } }]; }
      }]
    };`
  writeFileSync(join(release, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(join(release, "vite.config.ts"), fixtureConfig)
  writeFileSync(join(release, "index.html"), '<html><head></head><body><script type="module" src="/entry.js"></script></body></html>')
  writeFileSync(join(release, "entry.js"), "export const fixture = true;")
  const before = readdirSync(release).sort()
  for (const name of before) chmodSync(join(release, name), 0o444)
  chmodSync(release, 0o555)
  try {
    // Node, like the release service. A synthetic config prevents backend/dotenv imports.
    execFileSync("node", ["--permission", "--allow-fs-read=*", `--allow-fs-write=${cache}`, "--allow-addons", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const { releaseConfig } = await import(process.argv[1]);
      const { createServer } = await import(process.argv[2]);
      const root = process.argv[3];
      const config = releaseConfig({ TOUCHSTONE_VITE_CACHE_DIR: process.argv[4] });
      const server = await createServer({ ...config, root, configFile: join(root, 'vite.config.ts'),
        envFile: false, logLevel: 'silent', server: { ...config.server, middlewareMode: true, ws: false } });
      try {
        assert.equal(server.config.server.watch, null);
        assert.equal(server.config.server.hmr, false);
        assert.deepEqual(server.watcher.getWatched(), {});
        assert.equal(server.config.configLoader, 'runner');
        assert.equal(server.config.plugins.some(p => p.name === 'fixture-backend'), true);
        assert.equal(server.config.resolve.alias.find(a => a.find === '@').replacement, join(root, 'src'));
        const html = await server.transformIndexHtml('/', readFileSync(join(root, 'index.html'), 'utf8'));
        assert.match(html, /name="fixture-token" content="synthetic-only"/);
        assert.ok(await server.transformRequest('/entry.js'));
        assert.equal(server.config.server.watch, null);
        assert.deepEqual(server.watcher.getWatched(), {});
      } finally { await server.close(); }
    `, new URL("../server/start.mjs", import.meta.url).href, import.meta.resolve("vite"), release, cache], {
      cwd: dir, timeout: 20_000, stdio: "pipe",
    })
    expect(readdirSync(release).sort()).toEqual(before)
    expect(readFileSync(join(release, "vite.config.ts"), "utf8")).toBe(fixtureConfig)
  } finally {
    chmodSync(release, 0o755)
  }
}, 25_000)

test("start command uses Node and the launcher does not implement another backend", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  expect(pkg.scripts.start).toBe("node server/start.mjs")
  const source = readFileSync(new URL("../server/start.mjs", import.meta.url), "utf8")
  expect(source).toContain('(await import("vite")).createServer')
  expect(source).not.toMatch(/node:http|consoleToken\(|handleApi\(|handleRuns\(/)
})
