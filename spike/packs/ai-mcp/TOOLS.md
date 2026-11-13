# AI and MCP: integration research

Module M18. Same table as `packs/README.md`. The lab is one Express service: an
MCP server, a support assistant and a public ticket form. It plants six root
causes (see `SKILL.md`). Four tools are wrapped through `runTool()` in
`scan.mjs`: MCP Inspector, Nuclei, mcp-shield and garak. They run in the
prepass, in Docker. In a lab run the first three scan a throwaway copy of the
lab. In a live run they scan the operator's base URL. garak runs only in a live
run, and only when the operator set the assistant's chat path and a request
budget. Their output is LEADS. A lead is never a finding. Only a replayed script
that an oracle accepts is a finding.

## Wrapped today

| Tool | License | Runs as | Offline | Input | Output | Lead | Proof | Overlap | Lift | Gap | Verdict |
|------|------|------|------|------|------|------|------|------|------|------|------|
| `run_request_script` + `lib/proof-http.mjs` (ours) | Ours | Lab image `touchstone/ai-mcp-lab:dev`; a throwaway container on the same `--internal` network runs the script | Yes | A short JS script calling `request()` | A recorded `{method, path (raw path, no query or fragment), url, reqHeaders, reqBody, status, resHeaders, resBody}` transcript | The transcript | `http`: the same script replays on a FRESH lab and the oracle still passes | A manual proxy workflow | The harness and fresh-lab replay | Delivery mechanism for the rows below | wrap (ours) |
| Touchstone oracles (ours) | Ours | Pure functions in `pack.mjs` (`ORACLES`) | Yes | The transcript | `{ pass, detail }` | `prompt-injection-forbidden-tool`, `prompt-injection-data-exfil`, `fetch-url-scope-escape`, `mcp-tool-scope-bypass`, `tool-description-poisoning`, `mcp-tool-definition-rug-pull` | `http` | None found | None | No open-source tool decides "this tool call was caused by untrusted text" from a recorded transcript | own |
| MCP Inspector 0.17.2 (`@modelcontextprotocol/inspector`) | MIT | `runTool()` on `touchstone/mcp-inspector:0.17.2` (our pinned `node:20-slim` image, `npm install -g`, see `Dockerfile.inspector`), `--cli <url>/mcp --transport http --method tools/list --header "Authorization: Bearer …"` | Yes: it talks only to the lab on the private network | The MCP URL and a token | JSON tool list | One lead per risky tool: sends data out, changes or deletes, takes an address or a path. We read names and argument names only | none: a lead only | Our oracles prove the harm. The Inspector lists tools. It does not judge them | The official client. It speaks the real protocol (initialize, then `tools/list`), so a real MCP server works too | It shows what tools exist. It cannot see what a tool does or what an agent does with untrusted text | wrap (enumeration) |
| Nuclei v3.4.10 | MIT | `runTool()` on `projectdiscovery/nuclei:v3.4.10`, `-t /work/templates -jsonl -or -ot -duc` | Yes: our own template ships in `packs/ai-mcp/scan/templates/` | The base URL and the template | JSONL | `mcp-unauth-tools-list`: a 200 `tools/list` with no Authorization header | none: a lead only | None. The lab needs a token, so this template stays quiet on it: a clean result | The template is a cheap start for any MCP server | One template only. No stock template knows MCP | wrap (own template, offline) |
| mcp-shield 1.0.4 (`mcp-shield` on npm) | MIT | `runTool()` on `touchstone/mcp-shield:1.0.4`, built locally by `npm run build:labs -- shield` from `Dockerfile.shield`: the digest-pinned `node:20-slim` base, deps pinned by `shield/package-lock.json` (`npm ci --ignore-scripts`). The tag is local, so it has no registry digest. Our `shield/run.mjs` calls mcp-shield's own `scanMcpServer` and prints JSON. Our `shield/bridge.mjs` forwards its stdio to `<base>/mcp` over HTTP POST with `Authorization: Bearer $MCP_TOKEN`. Same limits as the other tools (120 s, the `runTool()` defaults) | Yes. `run.mjs` never passes a Claude key, so mcp-shield makes no model call. Target data stays on the machine. The build needs network; the scan does not | The MCP URL and a token (in the env, never on the command line) | One JSON line: `{ok, server:{toolCount, tools}, vulnerabilities}`, or `{ok:false, error}` and exit 2 | `shield-hidden-instructions`, `shield-tool-shadowing`, `shield-sensitive-file-access` (text patterns in a tool description), `shield-side-channel-argument` (a parameter named like `notes` or `metadata`), `shield-cross-origin-reference`. We keep the tool name, the rule names and parameter names only. The matched text is never copied | none: a lead only | Our `tool-description-poisoning` oracle proves description poisoning from the transcript. mcp-shield only flags text | It reads descriptions with a second, independent rule set, on any MCP server the operator runs | On the lab it finds nothing: its patterns miss the lab's `IMPORTANT:` poisoning in `lookup_customer`. That is a clean result, not proof of safety. A recorded run on our poisoned fixture shows it does fire. It reads the tool list only; it cannot see what a tool does. Cross-server checks need two or more servers, so they never fire here. It reads only `<base>/mcp` (POST, JSON or SSE replies; no redirects) | wrap (description patterns, offline) |
| garak 0.17.1 (NVIDIA) | Apache-2.0 | `runTool()` on `touchstone/garak:0.17.1`, built locally by `npm run build:labs -- garak` from `Dockerfile.garak`: the digest-pinned `python:3.12-slim` base, every Python dependency pinned by hash in `garak/requirements.lock` (`pip install --require-hashes`, CPU torch). The tag is local, so it has no registry digest. The image is about 3 GB, so it is not in the default build. Our `garak/run.py` drives it. garak's `rest` generator talks only to a relay on 127.0.0.1 inside the container. The relay forwards each prompt to `<base><path>` with `Authorization: Bearer $MCP_TOKEN`, counts every request, and stops at the budget or the deadline (480 s). Each probe runs on its own with an equal share of the budget. A 401 or 403 stops all spending. No redirects. Time cap 600 s; the other `runTool()` defaults | Yes for target data: the eight probes use only string or regex detectors, extended detectors are off, and the Hugging Face libraries are forced offline, so no detector model loads and no reply text goes to a third party. It does send prompts to the operator's own assistant, which may call a paid model: that is why it needs an explicit budget. The build needs network | **Live only.** The operator sets the assistant chat path and a budget of 8 to 200 requests in the live scope (`mcp.assistant`). Without them garak sends nothing and the run view says `garak did not run` with the reason. The request is `{"message": text}`, the reply is read from `reply` (both keys can be changed) | One JSON line: `{ok, budget, requests, replies, upstreamErrors, evals:[{probe, detector, passed, fails, total}], probeErrors}`, or `{ok:false, error}` and exit 2. Counts only: no prompt or reply text | `garak-<probe>` for each probe whose detector matched at least one reply: prompt-injection phrases (`promptinject.HijackHateHumans`, `HijackKillHumans`), hidden-instruction triggers in a document (`latentinjection.LatentInjectionReport`, `LatentInjectionResume`, `LatentWhois`), a markdown image that leaks data (`web_injection.MarkdownImageExfil`, `StringAssemblyDataExfil`), a script tag in the reply (`web_injection.TaskXSS`). We keep the probe name and the counts only | none: a lead only | Our `prompt-injection-forbidden-tool` and `prompt-injection-data-exfil` oracles prove harm from a recorded tool call. garak only reads reply text | A wide, maintained set of injection prompts against the operator's real model, under a hard request cap | A string match is not harm: an assistant that repeats the prompt (our echo stub) matches the phrase and script-tag checks. garak cannot see tool calls, so it never proves an injection did anything. A small budget sends only a few prompts per probe, so a quiet run says little. It never runs on the lab: the lab assistant is rule-based, not a model. It was tested only against a local echo stub on 127.0.0.1 (`test/fixtures/garak/`), never against a real model. Model-graded detectors (toxicity, jailbreak judges) are not used | wrap (live-only, budgeted, string detectors) |

## Evaluated, not wrapped

| Tool | License | Runs as | Offline | Verdict and reason |
|------|------|------|------|------|
| mcp-scan (Invariant Labs, now Snyk Agent Scan) | Apache-2.0 (check current repo) | Python CLI | **No.** It sends tool descriptions to a vendor API for analysis. A scan would send the operator's tool text off the machine. | skip — sends target data to a vendor API. This is a real offline break, not a mode claim. Revisit only if it gains a fully local mode. |
| promptfoo (red team) | MIT | Node CLI | Needs a model to generate attacks and to grade | skip — overlap (assumed, not tested). Same role as garak (wrapped above), and its grader is a model, so its verdict is a lead, never a finding. No comparison was run. |
| PyRIT | MIT | Python library | Needs a model | skip — overlap (assumed, not tested). Library, not a CLI. Same lead-only role as garak. |
| LLM Guard, NeMo Guardrails, Rebuff | Apache-2.0 / Apache-2.0 / Apache-2.0 | Defense filters, not scanners | n/a | read only. They are fixes to suggest, not tools to run |
| MCP servers' own test suites | per project | n/a | n/a | n/a. Out of scope: we test a server the operator runs, as a black box |
| ramparts (MCP scanner) | Apache-2.0 (check current repo) | CLI | **No** if its risk analysis of tool descriptions calls a model/API, like mcp-scan | skip — same real break as mcp-scan: it sends target tool text off-machine. For enumeration MCP Inspector already covers us, and our oracles judge harm. Revisit if it gains a fully local mode. |
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
- MCP Inspector, Nuclei and mcp-shield read the tool list only. They never call
  a tool. garak sends chat prompts to the assistant, up to the operator's budget.
  It never calls an MCP tool itself. Calling tools deliberately is the agent's
  job, one script at a time.
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
