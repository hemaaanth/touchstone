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

test("the private section stays first; only the rows inside a section follow the default", () => {
  // A non-NEAR default must not move the NEAR box off the top.
  expect(ids("lyber")).toEqual(["near", "lyber", "boundless"])
  expect(ids("near")).toEqual(["near", "boundless", "lyber"])
  expect(providers.map((p) => p.id)).toEqual(["near", "boundless", "lyber"])
})

test("order follows a replacement default after providers are removed or added", () => {
  const remaining = providers.filter((p) => p.id !== "lyber")
  expect(ids("boundless", remaining)).toEqual(["near", "boundless"])
  expect(ids("new", [...remaining, provider("new")])).toEqual(["near", "new", "boundless"])
  expect(ids(null)).toEqual(["near", "boundless", "lyber"])
  expect(groups(null, [])).toEqual([])
})
