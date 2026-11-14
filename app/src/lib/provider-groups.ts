import type { SettingsState } from "./types"

// Recompute from the saved state so changing or removing the default also moves it.
export function providerGroups(settings: Pick<SettingsState, "providers" | "default" | "envOverride">) {
  const providers = [...settings.providers].sort((a, b) => Number(b.id === settings.default.provider) - Number(a.id === settings.default.provider))
  const privateProviders = providers.filter((p) => p.id === "near" && originOf(p.baseUrl) === "https://cloud-api.near.ai")
  return [
    { title: "Private inference", description: undefined, providers: privateProviders, private: true },
    { title: "Other providers", description: settings.envOverride ? `The server fixes the provider to ${settings.envOverride}. Restart without PROVIDER to change it.` : undefined, providers: providers.filter((p) => !privateProviders.includes(p)), private: false },
  ].sort((a, b) => Number(b.providers.some((p) => p.id === settings.default.provider)) - Number(a.providers.some((p) => p.id === settings.default.provider)))
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

