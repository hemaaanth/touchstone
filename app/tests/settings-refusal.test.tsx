import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SettingsRefusal } from "../src/components/settings-page"

// A refused settings write must not move the page: the line floats in the gap
// under the title, and its box takes the same room with and without a message.
describe("Settings refusal line", () => {
  test("it floats over the page and its box is the same with or without a message", () => {
    const box = (html: string) => html.match(/^<div class="([^"]*)"/)?.[1]
    const none = renderToStaticMarkup(<SettingsRefusal text={null} />)
    const shown = renderToStaticMarkup(<SettingsRefusal text="The key was refused." />)
    expect(box(none)).toBe(box(shown))
    expect(box(none)).toContain("h-0")
    expect(shown).toMatch(/<p role="alert" class="[^"]*absolute[^"]*">The key was refused\.<\/p>/)
    expect(none).not.toContain("<p")
  })
})
