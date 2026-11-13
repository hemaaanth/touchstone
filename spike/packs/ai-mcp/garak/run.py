"""Run garak 0.17.1 against one chat endpoint with a hard request budget.

Usage (inside touchstone/garak:0.17.1):
  run.py <assistant URL>
Env:
  GARAK_BUDGET       required. The most requests that may reach the endpoint (1..200).
  GARAK_DEADLINE_S   optional. Stop sending after this many seconds (default 540).
  MCP_TOKEN          optional. Sent as "Authorization: Bearer <token>".
  GARAK_REQ_KEY      optional. JSON key for the prompt in the request (default "message").
  GARAK_REPLY_KEY    optional. JSON key for the text in the reply (default "reply").

How it works. garak's rest generator talks only to a relay on 127.0.0.1 in
this container. The relay is the only thing that talks to the endpoint. It
counts every request it forwards and stops at the budget or the deadline: after
that it answers 418 and garak skips the prompt. The token lives only in the
relay. It is never in garak's config or report. Redirects are not followed.

Only probes whose primary detector is a plain string or regex check run, with
extended detectors off. No detector model is loaded and the Hugging Face
libraries are offline, so no target text goes anywhere but the endpoint.

Output: one JSON line on stdout. Counts only: no prompt or reply text.
  {"ok": true, "tool": "garak", "version": "0.17.1", "budget": N, "requests": n,
   "replies": n, "skipped": n, "upstreamErrors": n, "upstreamStatus": {...},
   "evals": [{"probe", "detector", "passed", "fails", "nones", "total"}],
   "probeErrors": ["<probe>: <why>"]}
Each probe runs on its own with an equal share of the budget. Exit 0 when at
least one probe wrote eval records and at least one reply came back. Otherwise
{"ok": false, "error": "..."} and exit 2.
"""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.17.1"
MAX_BUDGET = 200
REQUEST_TIMEOUT_S = 20

# Probe -> primary detector. Each detector is a string or regex check
# (garak/detectors/{promptinject,base,web_injection}.py), never a model.
PROBES = [
    "promptinject.HijackHateHumans",
    "promptinject.HijackKillHumans",
    "latentinjection.LatentInjectionReport",
    "latentinjection.LatentInjectionResume",
    "latentinjection.LatentWhois",
    "web_injection.MarkdownImageExfil",
    "web_injection.StringAssemblyDataExfil",
    "web_injection.TaskXSS",
]


def fail(msg):
    sys.stdout.write(json.dumps({"ok": False, "tool": "garak", "version": VERSION, "error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(2)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Relay:
    def __init__(self, url, token, budget, deadline, req_key, reply_key):
        self.url, self.token, self.budget = url, token, budget
        self.deadline, self.req_key, self.reply_key = deadline, req_key, reply_key
        self.lock = threading.Lock()
        self.requests = 0
        self.replies = 0
        self.skipped = 0
        self.errors = 0
        self.status = {}
        self.opener = urllib.request.build_opener(NoRedirect)
        self.slice_left = budget
        self.refused = False

    def start_slice(self, n):
        with self.lock:
            self.slice_left = n

    def take(self):
        with self.lock:
            if (self.refused or self.requests >= self.budget or self.slice_left <= 0
                    or time.monotonic() > self.deadline):
                self.skipped += 1
                return False
            self.requests += 1
            self.slice_left -= 1
            return True

    def note(self, key, ok):
        with self.lock:
            self.status[key] = self.status.get(key, 0) + 1
            if ok:
                self.replies += 1
            else:
                self.errors += 1

    def forward(self, prompt):
        """Return (http status for garak, reply text or None)."""
        if not self.take():
            return 418, None
        body = json.dumps({self.req_key: prompt}).encode()
        headers = {"content-type": "application/json", "accept": "application/json"}
        if self.token:
            headers["authorization"] = "Bearer " + self.token
        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        try:
            with self.opener.open(req, timeout=REQUEST_TIMEOUT_S) as r:
                raw = r.read(1_000_000)
                code = r.status
        except urllib.error.HTTPError as e:
            self.note(str(e.code), False)
            if e.code in (401, 403):
                self.refused = True  # the token is refused: stop spending budget
            return 424, None
        except Exception as e:
            self.note(type(e).__name__, False)
            return 424, None
        try:
            text = json.loads(raw)[self.reply_key]
            if not isinstance(text, str):
                raise TypeError("reply is not text")
        except Exception:
            self.note(f"{code}-unreadable", False)
            return 424, None
        self.note(str(code), True)
        return 200, text


def serve(relay):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            try:
                prompt = json.loads(self.rfile.read(n))["text"]
            except Exception:
                prompt = None
            if not isinstance(prompt, str):
                code, text = 400, None
            else:
                code, text = relay.forward(prompt)
            out = json.dumps({"text": text} if code == 200 else {"error": code}).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def read_evals(report_dir):
    evals = []
    for name in sorted(os.listdir(report_dir)):
        if not name.endswith(".report.jsonl"):
            continue
        with open(os.path.join(report_dir, name)) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("entry_type") != "eval":
                    continue
                evals.append({
                    "probe": e.get("probe"),
                    "detector": e.get("detector"),
                    "passed": e.get("passed"),
                    "fails": e.get("fails"),
                    "nones": e.get("nones"),
                    "total": e.get("total_evaluated"),
                })
    return evals


def main():
    if len(sys.argv) != 2 or not sys.argv[1].startswith(("http://", "https://")):
        fail("usage: run.py <http(s) assistant URL>")
    url = sys.argv[1]
    try:
        budget = int(os.environ.get("GARAK_BUDGET", ""))
    except ValueError:
        fail("GARAK_BUDGET is not set. garak needs an explicit request budget.")
    if not 1 <= budget <= MAX_BUDGET:
        fail(f"GARAK_BUDGET must be 1..{MAX_BUDGET}, got {budget}")
    deadline_s = int(os.environ.get("GARAK_DEADLINE_S") or 540)
    relay = Relay(
        url, os.environ.get("MCP_TOKEN") or "", budget, time.monotonic() + deadline_s,
        os.environ.get("GARAK_REQ_KEY") or "message", os.environ.get("GARAK_REPLY_KEY") or "reply",
    )
    srv = serve(relay)
    port = srv.server_address[1]

    work = "/tmp/garak-work"
    report_dir = os.path.join(work, "runs")
    os.makedirs(report_dir, exist_ok=True)
    if budget < len(PROBES):
        fail(f"GARAK_BUDGET must be at least {len(PROBES)} (one request per probe), got {budget}")
    with open(os.path.join(work, "gen.json"), "w") as f:
        json.dump({"rest": {"RestGenerator": {
            "name": "touchstone-relay",
            "uri": f"http://127.0.0.1:{port}/",
            "method": "post",
            "headers": {"content-type": "application/json"},
            "req_template_json_object": {"text": "$INPUT"},
            "response_json": True,
            "response_json_field": "text",
            "request_timeout": REQUEST_TIMEOUT_S + 5,
            "ratelimit_codes": [],
            "skip_codes": [400, 418, 424],
        }}}, f)
    # Each probe gets its own garak run and an equal share of the budget, so
    # one large probe cannot use it all. The total cap holds in the relay.
    share, extra = divmod(budget, len(PROBES))
    failures = []
    for i, probe in enumerate(PROBES):
        n = share + (1 if i < extra else 0)
        cfg = os.path.join(work, f"cfg-{i}.yaml")
        with open(cfg, "w") as f:
            f.write(
                "system:\n  lite: true\n  parallel_attempts: false\n  parallel_requests: false\n"
                f"run:\n  generations: 1\n  soft_probe_prompt_cap: {n}\n  seed: 7\n"
                "plugins:\n  extended_detectors: false\n"
                f"reporting:\n  report_dir: {report_dir}\n  report_prefix: touchstone-{i}\n"
            )
        relay.start_slice(n)
        left = relay.deadline - time.monotonic()
        if left <= 0:
            failures.append(f"{probe}: deadline reached before it ran")
            continue
        cmd = [
            sys.executable, "-m", "garak", "--config", cfg, "--target_type", "rest",
            "--generator_option_file", os.path.join(work, "gen.json"), "--probes", probe,
        ]
        try:
            p = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=left + 60)
        except subprocess.TimeoutExpired:
            failures.append(f"{probe}: did not finish in time")
            continue
        if p.returncode != 0:
            tail = (p.stderr or p.stdout or "").strip().splitlines()[-1:] or ["no output"]
            failures.append(f"{probe}: garak exited {p.returncode}: {tail[0][:200]}")
    srv.shutdown()
    evals = read_evals(report_dir) if os.path.isdir(report_dir) else []
    counts = {
        "budget": budget, "requests": relay.requests, "replies": relay.replies,
        "skipped": relay.skipped, "upstreamErrors": relay.errors, "upstreamStatus": relay.status,
    }
    if not evals:
        fail("garak wrote no eval records: " + ("; ".join(failures) or "no reason given"))
    if relay.replies == 0:
        fail(f"no reply came back from the endpoint ({relay.requests} requests, status {relay.status})")
    sys.stdout.write(json.dumps({"ok": True, "tool": "garak", "version": VERSION, **counts, "evals": evals, "probeErrors": failures}) + "\n")


if __name__ == "__main__":
    main()
