import { expect, test } from "bun:test"
import { providerGroups } from "../src/lib/provider-groups"
import type { ProviderSetting } from "../src/lib/types"

const provider = (id: string): ProviderSetting => ({
  id, label: id, baseUrl: id === "near" ? "https://cloud-api.near.ai/v1" : `https://${id}.example/v1`,
  builtIn: true, saved: true, key: { set: false, source: null, last4: null }, models: [],
})
const providers = [provider("near"), provider("boundless"), provider("lyber")]
const groups = (defaultId: string | null, list = providers) => providerGroups({
  providers: list, default: { provider: defaultId, model: null }, envOverride: null,
}).filter((group) => group.providers.length)
const ids = (defaultId: string | null, list = providers) => groups(defaultId, list).flatMap((group) => group.providers.map((p) => p.id))

test("the default provider and its section come first without mutating saved order", () => {
  expect(ids("lyber")).toEqual(["lyber", "boundless", "near"])
  expect(ids("near")).toEqual(["near", "boundless", "lyber"])
  expect(providers.map((p) => p.id)).toEqual(["near", "boundless", "lyber"])
})

test("order follows a replacement default after providers are removed or added", () => {
  const remaining = providers.filter((p) => p.id !== "lyber")
  expect(ids("boundless", remaining)).toEqual(["boundless", "near"])
  expect(ids("new", [...remaining, provider("new")])).toEqual(["new", "boundless", "near"])
  expect(ids(null)).toEqual(["near", "boundless", "lyber"])
  expect(groups(null, [])).toEqual([])
})
