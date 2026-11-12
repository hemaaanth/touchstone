# AI and MCP: integration research

Module M6. Same table as `packs/README.md`. The lab is one Express service: an
MCP server, a support assistant and a public ticket form. It plants three root
causes (see `SKILL.md`). Two tools are wrapped through `runTool()` in
`scan.mjs`: MCP Inspector and Nuclei. They run in the prepass, in Docker, on a
throwaway copy of the lab. Their output is LEADS. A lead is never a finding.
Only a replayed script that an oracle accepts is a finding.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| `run_request_script` + `lib/proof-http.mjs` (ours) | Ours | Lab image `touchstone/ai-mcp-lab:dev`; a throwaway container on the same `--internal` network runs the script | Yes | A short JS script calling `request()` | A recorded `{method, path, reqHeaders, reqBody, status, resHeaders, resBody}` transcript | The transcript | `http`: the same script replays on a FRESH lab and the oracle still passes | A manual proxy workflow | The harness and fresh-lab replay | Delivery mechanism for the rows below | wrap (ours) |
| Touchstone oracles (ours) | Ours | Pure functions in `pack.mjs` (`ORACLES`) | Yes | The transcript | `{ pass, detail }` | `prompt-injection-forbidden-tool`, `fetch-url-scope-escape`, `mcp-tool-scope-bypass` | `http` | None found | None | No open-source tool decides "this tool call was caused by untrusted text" from a recorded transcript | own |
| MCP Inspector 0.17.2 (`@modelcontextprotocol/inspector`) | MIT | `runTool()` on `touchstone/mcp-inspector:0.17.2` (our pinned `node:20-slim` image, `npm install -g`, see `Dockerfile.inspector`), `--cli <url>/mcp --transport http --method tools/list --header "Authorization: Bearer …"` | Yes: it talks only to the lab on the private network | The MCP URL and a token | JSON tool list | One lead per risky tool: sends data out, changes or deletes, takes an address or a path. We read names and argument names only | none: a lead only | Our oracles prove the harm. The Inspector lists tools. It does not judge them | The official client. It speaks the real protocol (initialize, then `tools/list`), so a real MCP server works too | It shows what tools exist. It cannot see what a tool does or what an agent does with untrusted text | wrap (enumeration) |
| Nuclei v3.4.10 | MIT | `runTool()` on `projectdiscovery/nuclei:v3.4.10`, `-t /work/templates -jsonl -or -ot -duc` | Yes: our own template ships in `packs/ai-mcp/scan/templates/` | The base URL and the template | JSONL | `mcp-unauth-tools-list`: a 200 `tools/list` with no Authorization header | none: a lead only | None. The lab needs a token, so this template stays quiet on it: a clean result | The template is a cheap start for any MCP server | One template only. No stock template knows MCP | wrap (own template, offline) |

## Evaluated, not wrapped

| Tool | License | Runs as | Offline | Verdict and reason |
|------|------|------|------|------|
| mcp-scan (Invariant Labs, now Snyk Agent Scan) | Apache-2.0 (check current repo) | Python CLI | **No.** It sends tool descriptions to a vendor API for analysis. A scan would send the operator's tool text off the machine. | skip: breaks the offline rule. Revisit only if it gains a fully local mode |
| garak | Apache-2.0 | Python CLI that probes an LLM endpoint | Needs a model endpoint. Our lab's assistant is rule-based, so there is nothing to probe | skip for this lab. It is the right lead source for a REAL model: run it against the live agent behind the scope proxy and feed its hits in as leads |
| promptfoo (red team) | MIT | Node CLI | Needs a model to generate attacks and to grade | skip for this lab. Same role as garak. Its grader is a model, so its verdict is a lead, never a finding |
| PyRIT | MIT | Python library | Needs a model | skip. Library, not a CLI. Same lead-only role |
| LLM Guard, NeMo Guardrails, Rebuff | Apache-2.0 / Apache-2.0 / Apache-2.0 | Defense filters, not scanners | n/a | read only. They are fixes to suggest, not tools to run |
| MCP servers' own test suites | per project | n/a | n/a | n/a. Out of scope: we test a server the operator runs, as a black box |

## Gaps in our wrapping

- **Live target (acceptance line 6) is not done.** `prepass(ws, { target: {
  net, baseUrl, token } })` is the hook, so a granted target plugs in. But the
  agent's `run_request_script` still replays on the lab image. The scope proxy
  and grant (thread 7) do not exist yet.
- The scanners read the tool list only. They never call a tool. Calling tools
  against a real server is an action with effects. It needs the scope grant
  first.
- The assistant in the lab is rule-based. A real LLM agent is not
  deterministic, so a replay may not repeat. A live module needs a replay rule
  for that (for example "passes 2 of 3 replays"). It is not built.
- Only one untrusted channel is planted (the ticket form). Hidden text in a web
  page, a file or a tool description (tool poisoning) is not covered.
- The token table the oracles use is the lab's own. A live target needs its own
  table from the operator.
