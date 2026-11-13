import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ListRow } from "../src/components/page-parts"
import { ModulePill } from "../src/components/module-pill"

// ListRow's optional `name`: a node (the Modules page passes a ModulePill)
// shown in place of the title text. `title` stays the row button's accessible
// name. Without `name` the row renders as before (the Scopes page path).

const row = (props: Partial<Parameters<typeof ListRow>[0]>) =>
  renderToStaticMarkup(
    <ul>
      <ListRow title="Web and sign-in" meta={["HTTP replay"]} {...props} />
    </ul>,
  )

describe("ListRow name", () => {
  test("a row with a name shows the node, and its button keeps the title as its accessible name", () => {
    const html = row({ name: <ModulePill id="web" label="Web and sign-in" />, onOpen: () => {} })
    expect(html).toContain('data-slot="module-pill"')
    expect(html).toContain('data-module="web"')
    expect(html).toMatch(/<button[^>]*data-row-main[^>]*aria-label="Web and sign-in"|<button[^>]*aria-label="Web and sign-in"[^>]*data-row-main/)
    // The name is said once: no second, plain title text beside the pill.
    expect(html.match(/Web and sign-in/g)?.length).toBe(2) // aria-label + pill text
  })

  test("a row with a name and no detail shows the node without a button", () => {
    const html = row({ name: <ModulePill id="web" label="Web and sign-in" /> })
    expect(html).toContain('data-slot="module-pill"')
    expect(html).not.toContain("<button")
  })

  test("a row without a name renders the title text as before", () => {
    const html = row({ onOpen: () => {} })
    expect(html).not.toContain('data-slot="module-pill"')
    expect(html).not.toContain("aria-label=")
    expect(html).toContain('<span class="truncate">Web and sign-in</span>')
  })
})
