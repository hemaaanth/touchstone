# A private moto cloud, seeded from one pinned IaC snapshot.
#
# This image is the lab for an `http` proof. See live-cloud.mjs.
# Moto enforces IAM only when INITIAL_NO_AUTH_ACTION_COUNT is 0 (set in the
# Dockerfile env). The seed runs in this process, so it bootstraps one admin
# user through moto's own backend before it signs any HTTP call.
#
# Port 5001 is moto. Port 5000 is the gate: scripts reach only the gate. The
# gate starts after the seed, so a passing readiness probe means the seed
# finished. The pipeline recorder in proof-http.mjs records the gate's traffic.
import json
import os
import threading
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from moto.core import DEFAULT_ACCOUNT_ID as ACCOUNT
from moto.iam.models import iam_backends
from moto.s3.models import s3_backends
from moto.server import ThreadedMotoServer

INNER_PORT = 5001
GATE_PORT = 5000
# Host is kept: SigV4 signs it, so the gate must pass it through unchanged.
SKIP = {"connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te"}
ready = threading.Event()
lab = {}


def seed():
    spec = json.loads(os.environ["LAB_SEED"])
    iam = iam_backends[ACCOUNT]["global"]
    s3 = s3_backends[ACCOUNT]["global"]
    # The first identity cannot sign in before it exists.
    iam.create_user("us-east-1", "seed")
    key = iam.create_access_key("seed")
    iam.put_user_policy("seed", "admin", json.dumps(
        {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}))
    if spec.get("appBucket"):
        s3.create_bucket(spec["appBucket"], "us-east-1")
        s3.put_object(spec["appBucket"], "index.html", b"Throwaway moto frontend")
    s3.create_bucket(spec["treasuryBucket"], "us-east-1")
    s3.put_object(spec["treasuryBucket"], spec["treasuryKey"],
                  json.dumps({"marker": spec["marker"], "note": "another team's bucket"}).encode())
    import boto3
    client = dict(endpoint_url=f"http://127.0.0.1:{INNER_PORT}", region_name="us-east-1",
                  aws_access_key_id=key.access_key_id, aws_secret_access_key=key.secret_access_key)
    iamc = boto3.client("iam", **client)
    # Moto wants a keyed principal. Real AWS also accepts a bare "*" here.
    trust = spec["trust"]
    for statement in trust.get("Statement", []):
        if isinstance(statement.get("Principal"), str):
            statement["Principal"] = {"AWS": statement["Principal"]}
    iamc.create_role(RoleName=spec["roleName"], AssumeRolePolicyDocument=json.dumps(trust))
    if spec.get("policy"):
        iamc.put_role_policy(RoleName=spec["roleName"], PolicyName="grant", PolicyDocument=json.dumps(spec["policy"]))
    # The attacker's own account key. Assume is all their account grants them.
    iamc.create_user(UserName="attacker")
    attacker = iamc.create_access_key(UserName="attacker")["AccessKey"]
    iamc.put_user_policy(UserName="attacker", PolicyName="assume", PolicyDocument=json.dumps(
        {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "*"}]}))
    lab.update({
        "roleArn": f"arn:aws:iam::{ACCOUNT}:role/{spec['roleName']}",
        "accessKeyId": attacker["AccessKeyId"],
        "secretAccessKey": attacker["SecretAccessKey"],
        "treasuryBucket": spec["treasuryBucket"],
        "treasuryKey": spec["treasuryKey"],
        "marker": spec["marker"],
    })
    ready.set()


def forward(method, path, headers, body):
    up = HTTPConnection("127.0.0.1", INNER_PORT, timeout=20)
    try:
        up.request(method, path, body=body, headers={k: v for k, v in headers.items() if k.lower() not in SKIP})
        res = up.getresponse()
        return res.status, {k: v for k, v in res.getheaders() if k.lower() not in SKIP}, res.read()
    finally:
        up.close()


class Gate(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def route(self):
        if self.path == "/healthz":
            return (200, {"content-type": "text/plain"}, b"ok") if ready.is_set() else (503, {}, b"seeding")
        if self.path == "/__lab.json":
            return 200, {"content-type": "application/json"}, json.dumps(lab).encode()
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        return forward(self.command, self.path, self.headers, body)

    def respond(self):
        try:
            status, headers, body = self.route()
        except Exception as err:  # a broken upstream is a lab error, not a crash
            status, headers, body = 502, {"content-type": "text/plain"}, f"lab gate: {err}".encode()
        self.send_response(status)
        for k, v in headers.items():
            if k.lower() not in ("connection", "content-length", "transfer-encoding"):
                self.send_header(k, v)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = respond
    def log_message(self, *args): pass


if __name__ == "__main__":
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=INNER_PORT, verbose=False)
    server.start()
    seed()
    ThreadingHTTPServer(("0.0.0.0", GATE_PORT), Gate).serve_forever()
