# AI and MCP: integration research

Module M18. Same table as `packs/README.md`. The lab is one Express service: an
MCP server, a support assistant and a public ticket form. It plants six root
causes (see `SKILL.md`). Two tools are wrapped through `runTool()` in
`scan.mjs`: MCP Inspector and Nuclei. They run in the prepass, in Docker, on a
throwaway copy of the lab. Their output is LEADS. A lead is never a finding.
Only a replayed script that an oracle accepts is a finding.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| `run_request_script` + `lib/proof-http.mjs` (ours) | Ours | Lab image `touchstone/ai-mcp-lab:dev`; a throwaway container on the same `--internal` network runs the script | Yes | A short JS script calling `request()` | A recorded `{method, path (raw path, no query or fragment), url, reqHeaders, reqBody, status, resHeaders, resBody}` transcript | The transcript | `http`: the same script replays on a FRESH lab and the oracle still passes | A manual proxy workflow | The harness and fresh-lab replay | Delivery mechanism for the rows below | wrap (ours) |
| Touchstone oracles (ours) | Ours | Pure functions in `pack.mjs` (`ORACLES`) | Yes | The transcript | `{ pass, detail }` | `prompt-injection-forbidden-tool`, `prompt-injection-data-exfil`, `fetch-url-scope-escape`, `mcp-tool-scope-bypass`, `tool-description-poisoning`, `mcp-tool-definition-rug-pull` | `http` | None found | None | No open-source tool decides "this tool call was caused by untrusted text" from a recorded transcript | own |
| MCP Inspector 0.17.2 (`@modelcontextprotocol/inspector`) | MIT | `runTool()` on `touchstone/mcp-inspector:0.17.2` (our pinned `node:20-slim` image, `npm install -g`, see `Dockerfile.inspector`), `--cli <url>/mcp --transport http --method tools/list --header "Authorization: Bearer …"` | Yes: it talks only to the lab on the private network | The MCP URL and a token | JSON tool list | One lead per risky tool: sends data out, changes or deletes, takes an address or a path. We read names and argument names only | none: a lead only | Our oracles prove the harm. The Inspector lists tools. It does not judge them | The official client. It speaks the real protocol (initialize, then `tools/list`), so a real MCP server works too | It shows what tools exist. It cannot see what a tool does or what an agent does with untrusted text | wrap (enumeration) |
| Nuclei v3.4.10 | MIT | `runTool()` on `projectdiscovery/nuclei:v3.4.10`, `-t /work/templates -jsonl -or -ot -duc` | Yes: our own template ships in `packs/ai-mcp/scan/templates/` | The base URL and the template | JSONL | `mcp-unauth-tools-list`: a 200 `tools/list` with no Authorization header | none: a lead only | None. The lab needs a token, so this template stays quiet on it: a clean result | The template is a cheap start for any MCP server | One template only. No stock template knows MCP | wrap (own template, offline) |

## Evaluated, not wrapped

| Tool | License | Runs as | Offline | Verdict and reason |
|------|------|------|------|------|
| mcp-scan (Invariant Labs, now Snyk Agent Scan) | Apache-2.0 (check current repo) | Python CLI | **No.** It sends tool descriptions to a vendor API for analysis. A scan would send the operator's tool text off the machine. | skip — sends target data to a vendor API. This is a real offline break, not a mode claim. Revisit only if it gains a fully local mode. |
| garak | Apache-2.0 | Python CLI that probes an LLM endpoint | Needs a model endpoint. The lab's assistant is rule-based, so there is nothing to probe offline | backlog — live model probing. On a live target with a real model, run it behind the scope proxy and feed its hits in as leads. The live path exists (`pack.mjs:752` sets `live: true`); the requirement is a target that actually runs a model. |
| promptfoo (red team) | MIT | Node CLI | Needs a model to generate attacks and to grade | skip — overlap (assumed, not tested). Same role as garak, and its grader is a model, so its verdict is a lead, never a finding. No comparison was run. |
| PyRIT | MIT | Python library | Needs a model | skip — overlap (assumed, not tested). Library, not a CLI. Same lead-only role as garak. |
| LLM Guard, NeMo Guardrails, Rebuff | Apache-2.0 / Apache-2.0 / Apache-2.0 | Defense filters, not scanners | n/a | read only. They are fixes to suggest, not tools to run |
| MCP servers' own test suites | per project | n/a | n/a | n/a. Out of scope: we test a server the operator runs, as a black box |
| ramparts (MCP scanner) | Apache-2.0 (check current repo) | CLI | **No** if its risk analysis of tool descriptions calls a model/API, like mcp-scan | skip — same real break as mcp-scan: it sends target tool text off-machine. For enumeration MCP Inspector already covers us, and our oracles judge harm. Revisit if it gains a fully local mode. |
| mcp-shield | MIT (check current repo) | CLI | Pattern scan of tool descriptions; local if it ships no model call | backlog — MCP description leads. A text pattern is a lead, and our `tool-description-poisoning` oracle already proves that class from the transcript, so it adds nothing on the lab. Wiring it for a real server requires a fully local mode, with no model or API call. |
| AI-Infra-Guard | per repo | CLI + fingerprint DB | Needs its fingerprint DB; targets real AI deployments | skip — overlap (assumed, not tested): its HTTP fingerprints are assumed to overlap Nuclei; it was not run. Out of this module's black-box single-MCP scope, live or lab. |
| Agentic Radar | per repo | Static analysis of agent source/workflow | Analyzes the agent's own source and tool graph | skip: different input. This pack tests a server as a black box and does not have the agent's source to analyze |

## Gaps in our wrapping

- **A live target is wired** (`live: true`). The prepass binds the reach
  boundary and scans the real base URL; `run_request_script` and the proof
  replay are confined. The operator's token comes from the scope; without a
  token/scope table the scope-bypass check cannot fire, and the prompt says so.
  The scan stage itself runs on the bridge network (its tools need DNS), so the
  grant there is enforced in code, not by the network. The scanner assumes the
  MCP endpoint is `<base>/mcp`; a target with another path needs it in the scope
  blurb, which the agent reads even though the scanner will miss it.
- The scanners read the tool list only. They never call a tool. Calling tools
  deliberately is the agent's job, one script at a time.
- The assistant in the lab is rule-based. A real LLM agent is not
  deterministic, so a replay may not repeat. A live module needs a replay rule
  for that (for example "passes 2 of 3 replays"). It is not built.
- Untrusted channels planted: the ticket form and a tool description. Hidden
  text in a web page or a file is not covered.
- The oracles trust the lab assistant's `why` label per tool call. A live agent
  needs its own call trace. See SKILL.md, "What the oracles assume".
- Secret shapes: the lab's two are built in. Others come from
  `TOUCHSTONE_MCP_SECRET_PATTERNS` (one regex per line; a bad one throws).
- Lab images are built by `npm run build:labs` (`scripts/build-labs.sh`). A
  missing image makes the prepass fail loudly.
- The token table the oracles use is the lab's own. A live target needs its own
  table from the operator.
