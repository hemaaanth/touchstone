import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react"
import { Thread } from "../src/components/run-thread"
import type { RunFailure } from "../src/lib/runModel"

// A recorded run that did not read its whole scope must not look clean in the
// thread view (largerepo-delta-review Minor 2). Thread shows the coverage note
// as a warning card: the title and hint, but no spend line and no "Run again",
// because the run did not fail. An error card still wins over the note.

const gap: RunFailure = {
  kind: "coverage",
  title: "Part of the scope was not read",
  hint: "Split the repo into folder URLs and run again.",
  detail: "Not read:\n- https://github.com/cosmos/cosmos-sdk: refused",
  message: "A finding was recorded, but part of the scope was not read.",
  // retryable is true on purpose: only the warning flag may hide the button.
  retryable: true,
  spentUsd: 0.25,
}
const crash: RunFailure = { ...gap, kind: "crash", title: "The run stopped unexpectedly", hint: "Press Run again.", message: "crash" }

function render(props: { error?: string | null; errorInfo?: RunFailure | null; coverage?: RunFailure | null }): string {
  function Host() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: [], isRunning: false, onNew: async () => {}, convertMessage: (m) => m })
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(Thread, {
        prepass: null,
        error: props.error ?? null,
        errorInfo: props.errorInfo ?? null,
        coverage: props.coverage ?? null,
        onRetry() {},
        retrying: false,
        archived: false,
        notice: null,
        readOnly: true,
      }),
    )
  }
  return renderToStaticMarkup(createElement(Host))
}

describe("Thread: the coverage warning on a recorded run", () => {
  test("a recorded run with a gap shows the warning card, with no spend line and no Run again", () => {
    const html = render({ coverage: gap })
    expect(html).toContain("Part of the scope was not read")
    expect(html).toContain("Split the repo into folder URLs")
    expect(html).not.toContain("was spent")
    expect(html).not.toContain("Run again")
  })
  test("a run with no gap and no error shows no card", () => {
    const html = render({})
    expect(html).not.toContain("Part of the scope was not read")
    expect(html).not.toContain("Run again")
  })
  test("an error card wins over the coverage note", () => {
    const html = render({ errorInfo: crash, coverage: gap })
    expect(html).toContain("The run stopped unexpectedly")
    expect(html).not.toContain("Part of the scope was not read")
  })
})
