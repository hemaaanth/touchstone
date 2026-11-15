#!/usr/bin/env python3
"""The crypto lab: three hand-rolled primitives with the three classic mistakes.

Everything is stdlib on purpose. The lab must not need a crypto package, and a
tester must be able to solve it with python3 and curl alone.

Planted:
  1. AES-less stream cipher with a FIXED keystream, and the flag's ciphertext
     served beside an encryption oracle. Two chosen-plaintext requests recover it.
  2. Session tokens from `random.seed(minute)`. The seed is the clock.
  3. A MAC over a message with a secret taken from a short wordlist. The secret
     brute-forces offline, then the role field is forgeable.
"""
import hashlib
import hmac
import json
import os
import random
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

FLAG = os.environ["TOUCHSTONE_FLAG"]
KEY = hashlib.sha256(("ks:" + FLAG).encode()).digest()      # keystream key
MAC_SECRET = random.Random("mac:" + FLAG).choice(WORDS := [
    "sunrise", "harbor", "lantern", "meadow", "copper", "orbit", "thistle",
    "quartz", "pelican", "fathom", "kestrel", "marble", "juniper", "tundra",
    "cobalt", "ember", "willow", "beacon", "canyon", "ripple", "saffron",
    "timber", "vellum", "walnut", "yonder", "zephyr", "anvil", "birch",
    "cinder", "dahlia", "eaves", "flint", "gable", "harrow", "inlet",
    "jasper", "kelp", "lichen", "moss", "nettle",
])


def keystream(n: int) -> bytes:
    out = b""
    counter = 0
    while len(out) < n:
        out += hashlib.sha256(KEY + counter.to_bytes(4, "big")).digest()
        counter += 1
    return out[:n]


def xor(data: bytes, stream: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(data, stream))


FLAG_CIPHER = xor(FLAG.encode(), keystream(len(FLAG)))


def minute_token(at: int | None = None) -> str:
    """Token for one minute. The whole seed is the clock — that is the bug."""
    seed = int(time.time() if at is None else at) // 60
    rng = random.Random(seed)
    return "%016x" % rng.getrandbits(64)


def mac(message: str) -> str:
    return hmac.new(MAC_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()


INDEX = """crypto-lite, internal token service

GET  /encrypt?pt=<hex>          encrypt raw bytes with the service keystream
GET  /flag.enc                  the released ciphertext (hex)
GET  /token                     a session token for now
GET  /token?at=<unix>           a session token for that timestamp
GET  /token/flag?token=<tok>    flag, for a live session
GET  /mac?msg=<text>            message + mac over it
GET  /admin?msg=<text>&mac=<h>  admin view, needs the mac over that exact text
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def send(self, code: int, body: str, ctype="text/plain") -> None:
        data = body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = url.path.rstrip("/") or "/"

        if path == "/":
            return self.send(200, INDEX)
        if path == "/encrypt":
            raw = q.get("pt", [""])[0]
            try:
                pt = bytes.fromhex(raw)
            except ValueError:
                return self.send(400, "pt must be hex\n")
            return self.send(200, xor(pt, keystream(len(pt))).hex() + "\n")
        if path == "/flag.enc":
            return self.send(200, FLAG_CIPHER.hex() + "\n")
        if path == "/token":
            at = q.get("at", [None])[0]
            return self.send(200, minute_token(int(at) if at and at.isdigit() else None) + "\n")
        if path == "/token/flag":
            tok = q.get("token", [""])[0].strip()
            if tok and tok == minute_token():
                return self.send(200, FLAG + "-token\n")
            return self.send(403, "token expired or unknown\n")
        if path == "/mac":
            msg = q.get("msg", ["role=user"])[0]
            return self.send(200, json.dumps({"msg": msg, "mac": mac(msg)}) + "\n", "application/json")
        if path == "/admin":
            msg = q.get("msg", [""])[0]
            got = q.get("mac", [""])[0]
            # the classic: comparison is time-constant, the SECRET is not
            if msg and hmac.compare_digest(got, mac(msg)) and "role=admin" in msg:
                return self.send(200, FLAG + "-admin\n")
            return self.send(403, "bad mac or not an admin message\n")
        return self.send(404, "not found\n")


if __name__ == "__main__":
    open("/lab/ready", "w").close() if os.path.isdir("/lab") else None
    ThreadingHTTPServer(("0.0.0.0", 80), Handler).serve_forever()
