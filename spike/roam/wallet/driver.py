#!/usr/bin/env python3
"""Private trusted-machine driver. No keys, arbitrary RPC, upstream or logs."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

IMAGE = "ghcr.io/foundry-rs/foundry:latest@sha256:3a392c18f9b16e665e932de159fb6fa9ed972c4b4352f2f76a1a8c7ca9b57d39"
CHAIN = 31337
LIMIT = 262144
COMMAND = ["--ipc", "/wallet/anvil.ipc", "--host", "127.0.0.1", "--chain-id", str(CHAIN), "--accounts", "0", "--silent"]


def docker(args):
    # Arguments never contain a key, payload, signed tx or external RPC URL.
    result = subprocess.run(["docker", *args], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=60, check=True)
    if len(result.stdout) > LIMIT:
        raise ValueError("bounded output")
    return result.stdout.decode().strip()


def rpc(directory, method, params):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(10)
        client.connect(str(directory / "anvil.ipc"))
        client.sendall((json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}) + "\n").encode())
        data = b""
        while len(data) <= LIMIT:
            chunk = client.recv(min(65536, LIMIT + 1 - len(data)))
            if not chunk:
                break
            data += chunk
            try:
                result = json.loads(data)
                if result.get("id") != 1 or "error" in result or "result" not in result:
                    raise ValueError("rpc failure")
                return result["result"]
            except json.JSONDecodeError:
                continue
        raise ValueError("bounded rpc failure")


def checked(directory, lease):
    state = json.loads((directory / "state.json").read_text())
    if state.get("lease") != lease or not re.fullmatch(r"[a-f0-9]{64}", state.get("container", "")):
        raise ValueError("lifecycle changed")
    container = json.loads(docker(["inspect", state["container"]]))[0]
    config = container["Config"]
    host = container["HostConfig"]
    if (container.get("Id") != state["container"] or not container["State"].get("Running")
            or container["State"].get("StartedAt") != state["started"]
            or container.get("RestartCount", 0) != 0
            or container.get("Image") != state["image"]
            or config.get("Labels", {}).get("touchstone.wallet") != lease
            or config.get("Entrypoint") != ["anvil"] or config.get("Cmd") != COMMAND
            or host.get("NetworkMode") != "none" or host.get("Privileged")
            or host.get("PublishAllPorts") or host.get("PortBindings")
            or host.get("Binds") != [str(directory) + ":/wallet"]
            or host.get("LogConfig", {}).get("Type") != "none"
            or not host.get("ReadonlyRootfs") or host.get("CapDrop") != ["ALL"]
            or any(value for value in container.get("NetworkSettings", {}).get("Ports", {}).values())):
        raise ValueError("isolation changed")
    if rpc(directory, "eth_chainId", []) != hex(CHAIN):
        raise ValueError("chain changed")
    return state


def start(directory, lease, address):
    if not isinstance(address, str) or not re.fullmatch(r"0x[a-fA-F0-9]{40}", address):
        raise ValueError("invalid signer")
    path = directory / "state.json"
    if path.exists():
        if checked(directory, lease)["address"] != address:
            raise ValueError("signer changed")
        return
    image = json.loads(docker(["image", "inspect", IMAGE]))[0]["Id"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("missing pinned image")
    container = docker(["run", "-d", "--pull=never", "--network", "none",
                        "--name", "ts-wallet-" + lease, "--label", "touchstone.wallet=" + lease,
                        "--user", "0:0",
                        "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16777216",
                        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                        "--pids-limit", "64", "--memory", "256m", "--log-driver", "none",
                        "-v", str(directory) + ":/wallet", "--entrypoint", "anvil", IMAGE, *COMMAND])
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise ValueError("bad container")
    started = json.loads(docker(["inspect", container]))[0]["State"].get("StartedAt")
    if not isinstance(started, str) or not started:
        raise ValueError("missing lifecycle identity")
    with path.open("x") as output:
        os.chmod(path, 0o600)
        json.dump({"lease": lease, "container": container, "image": image, "started": started, "address": address}, output)
    for attempt in range(50):
        try:
            checked(directory, lease)
            return
        except (FileNotFoundError, ConnectionRefusedError, socket.timeout):
            if attempt == 49:
                raise
            time.sleep(0.1)


def balance(directory, address):
    value = rpc(directory, "eth_getBalance", [address, "latest"])
    if not isinstance(value, str) or not re.fullmatch(r"0x(?:0|[1-9a-fA-F][a-fA-F0-9]{0,63})", value):
        raise ValueError("invalid balance")
    return str(int(value, 16))


def operator_fund(directory, address, balance_wei, done):
    # Never in handle's allowlist. Only the interactive owner terminal uses it.
    lease = directory.name.removeprefix("touchstone-wallet-")
    state = checked(directory, lease)
    if done is not True or address != state["address"] or not isinstance(balance_wei, str) or not re.fullmatch(r"[1-9][0-9]{0,77}", balance_wei) or int(balance_wei) >= 2**256:
        raise ValueError("invalid operator approval")
    rpc(directory, "anvil_setBalance", [address, hex(int(balance_wei))])
    checked(directory, lease)
    actual = balance(directory, address)
    if actual != balance_wei:
        raise ValueError("funding not verified")
    return {"address": address, "chain_id": CHAIN, "balance_wei": actual}


def handle(request, directory):
    lease = request.get("lease")
    if not isinstance(lease, str) or not re.fullmatch(r"[a-f0-9]{48}", lease) or directory.name != "touchstone-wallet-" + lease:
        raise ValueError("invalid binding")
    operation = request.get("op")
    allowed = {"start": {"op", "lease", "address"}, "status": {"op", "lease"},
               "prepare": {"op", "lease", "from", "to", "value_wei", "data"},
               "balance": {"op", "lease", "address"}, "submit": {"op", "lease", "raw"}}
    if operation not in allowed or set(request) != allowed[operation]:
        raise ValueError("invalid operation")
    if operation == "start":
        start(directory, lease, request["address"])
    else:
        checked(directory, lease)
    result = {"ok": True, "lease": lease, "chain_id": CHAIN}
    if operation == "balance":
        if request["address"] != checked(directory, lease)["address"]:
            raise ValueError("signer changed")
        result["balance_wei"] = balance(directory, request["address"])
    if operation == "prepare":
        if not all(isinstance(request[k], str) and re.fullmatch(r"0x[a-fA-F0-9]{40}", request[k]) for k in ["from", "to"]):
            raise ValueError("invalid target")
        if request["from"] != checked(directory, lease)["address"]:
            raise ValueError("signer changed")
        value = request["value_wei"]
        data = request["data"]
        if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,77}", value) or int(value) >= 2**256 or not isinstance(data, str) or len(data) > 131074 or not re.fullmatch(r"0x(?:[a-fA-F0-9]{2})*", data):
            raise ValueError("invalid transaction")
        tx = {"from": request["from"], "to": request["to"], "value": hex(int(value)), "data": data}
        result.update(nonce=rpc(directory, "eth_getTransactionCount", [request["from"], "pending"]),
                      gas_price=rpc(directory, "eth_gasPrice", []), gas_limit=rpc(directory, "eth_estimateGas", [tx]))
    if operation == "submit":
        raw = request["raw"]
        if not isinstance(raw, str) or len(raw) > 262000 or not re.fullmatch(r"0x(?:[a-fA-F0-9]{2})+", raw):
            raise ValueError("invalid signed transaction")
        tx_hash = rpc(directory, "eth_sendRawTransaction", [raw])
        if not isinstance(tx_hash, str) or not re.fullmatch(r"0x[a-fA-F0-9]{64}", tx_hash):
            raise ValueError("bad receipt")
        result["hash"] = tx_hash
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise ValueError("bounded request")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("invalid request")
        result = handle(request, Path(__file__).resolve().parent)
        print(json.dumps(result))
    except Exception:
        # Provider stderr and JSON-RPC errors may contain signed bytes. Never echo.
        print('{"ok":false,"error":"Private local wallet unavailable."}')
        sys.exit(1)


if __name__ == "__main__":
    main()
