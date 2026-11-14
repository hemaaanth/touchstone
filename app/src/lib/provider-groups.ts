import type { SettingsState } from "./types"

// Recompute from the saved state so changing or removing the default also moves it.
// The private section is pinned first: NEAR is where a key is entered and, for
// this operator, always the top box. Only the provider order INSIDE a section
// follows the default, so making another default moves one row, not the boxes.
export function providerGroups(settings: Pick<SettingsState, "providers" | "default" | "envOverride">) {
  const providers = [...settings.providers].sort((a, b) => Number(b.id === settings.default.provider) - Number(a.id === settings.default.provider))
  const privateProviders = providers.filter((p) => p.id === "near" && originOf(p.baseUrl) === "https://cloud-api.near.ai")
  return [
    { title: "Private inference", description: undefined, providers: privateProviders, private: true },
    { title: "Other providers", description: settings.envOverride ? `The server fixes the provider to ${settings.envOverride}. Restart without PROVIDER to change it.` : undefined, providers: providers.filter((p) => !privateProviders.includes(p)), private: false },
  ]
}

// The scheme, host and port of an http(s) URL, as the server compares them
// (redact-url.mjs originOf). "" when it is not one.
export function originOf(url: string) {
  try {
    const u = new URL(url)
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : ""
  } catch {
    return ""
  }
}

