import { createRoot } from "react-dom/client"
import { SessionCard } from "./src/components/run-thread"
import "./src/index.css"
const step = { key: "s", kind: "session" as const, label: "u", state: "running" as const, phase: "run" as const, detail: "paused · call cut", paused: true, session: { url: "http://127.0.0.1:4500/#tok", viewOnly: true } }
createRoot(document.getElementById("root")!).render(<SessionCard step={step} runId="r1" />)
