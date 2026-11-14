// Types for the part of "bun:test" these tests use. bun runs the tests, but
// the app has no bun type package (and adding one would change the shared
// node_modules), so tsc -b had nothing to check tests/ against. This file is
// for type checking only; bun never reads it.
declare module "bun:test" {
  type Body = () => void | Promise<unknown>

  interface Test {
    (name: string, fn: Body, timeout?: number): void
    skip(name: string, fn?: Body, timeout?: number): void
  }
  export const test: Test
  export function describe(name: string, fn: () => void): void
  export function beforeAll(fn: Body): void
  export function afterAll(fn: Body): void
  export function beforeEach(fn: Body): void
  export function afterEach(fn: Body): void

  interface Matchers {
    not: Matchers
    resolves: AsyncMatchers
    rejects: AsyncMatchers
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toMatchObject(expected: object): void
    toContain(expected: unknown): void
    toMatch(expected: string | RegExp): void
    toHaveLength(length: number): void
    toBeNull(): void
    toBeUndefined(): void
    toBeTruthy(): void
    toBeGreaterThan(n: number | bigint): void
    toBeGreaterThanOrEqual(n: number | bigint): void
    toBeLessThan(n: number | bigint): void
    toBeLessThanOrEqual(n: number | bigint): void
    toBeString(): void
    toThrow(expected?: string | RegExp | Error): void
    toHaveBeenCalledTimes(n: number): void
  }
  // The same matchers on a promise's value or error: each one is awaited.
  type AsyncMatchers = { [K in Exclude<keyof Matchers, "not" | "resolves" | "rejects">]: (...args: Parameters<Matchers[K]>) => Promise<void> }
  // bun takes an optional message, shown when the matcher fails.
  export function expect(actual: unknown, message?: string): Matchers

  interface MockState<A extends unknown[]> {
    calls: A[]
  }
  // A spy keeps the spied function's own type, plus its recorded calls.
  type Spy<F extends (...args: any[]) => any> = F & { mock: MockState<Parameters<F>>; mockRestore(): void }
  export function spyOn<T extends object, K extends keyof T>(obj: T, key: K): T[K] extends (...args: any[]) => any ? Spy<T[K]> : never
  export const mock: {
    module(specifier: string, factory: () => Record<string, unknown>): void
  }
}

// bun's own fields on import.meta (used for the test file's directory).
interface ImportMeta {
  readonly dir: string
}
