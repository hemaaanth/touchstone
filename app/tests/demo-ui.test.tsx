import "./helpers/isolated-env"
import { afterEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react"
import { AskHuman, AskHumanProvider } from "../src/components/ask-human"
import { Thread } from "../src/components/run-thread"
import { reduceEvents } from "../src/lib/runModel"
import { DEMO_ADMIN_MESSAGE } from "../src/lib/demo"

const globals = globalThis as { document?: unknown }
const original = globals.document
afterEach(() => { globals.document = original })
const setDemo = (enabled: boolean) => {
  globals.document = { querySelector: () => enabled ? { content: '{"budgetUsd":1,"maxMinutes":10}' } : null }
}

function FailedThread() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: [], convertMessage: (message) => message, onNew: async () => {} })
  return <AssistantRuntimeProvider runtime={runtime}><Thread prepass={null} error="Provider unavailable" errorInfo={{ kind: "account", title: "Provider key missing", hint: "Add an API key in Settings", detail: "", message: "Provider unavailable", retryable: true, spentUsd: 0 }} onRetry={() => {}} retrying={false} archived={false} notice={null} /></AssistantRuntimeProvider>
}

test("demo questions keep the request visible but offer no reply or approval controls", () => {
  const state = reduceEvents([{ ev: "ask-human", id: "q1", agent: "coordinator", kind: "question", question: "Inspect the evidence?", t: 1 }])
  const render = () => renderToStaticMarkup(<AskHumanProvider runId="demo" state={state} live><AskHuman ask={state.humanAsks[0]} /></AskHumanProvider>)
  setDemo(true)
  const demo = render()
  expect(demo).toContain("Inspect the evidence?")
  expect(demo).not.toContain("<input")
  expect(demo).not.toContain("<form")
  expect(demo).not.toContain(">Done</button>")
  setDemo(false)
  const owner = render()
  expect(owner).toContain("<input")
  expect(owner).toContain(">Done</button>")
})

test("demo provider failures hide the composer, continuation and owner setup path", () => {
  setDemo(true)
  const demo = renderToStaticMarkup(<FailedThread />)
  expect(demo).toContain(DEMO_ADMIN_MESSAGE)
  expect(demo).not.toContain("Settings")
  expect(demo).not.toContain("Run again")
  expect(demo).not.toContain("<textarea")
  setDemo(false)
  const owner = renderToStaticMarkup(<FailedThread />)
  expect(owner).toContain("Add an API key in Settings")
  expect(owner).toContain("Run again")
  expect(owner).toContain("<textarea")
})
