"""Demo-only Linux process-group cleanup. Never signal a numeric PID."""
import json
import os
import select
import signal
import sys
import time


def check():
    if not sys.platform.startswith("linux"):
        raise RuntimeError("Linux is required")
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)


def stat(pid):
    try:
        with open(f"/proc/{pid}/stat") as source:
            fields = source.read().rsplit(") ", 1)[1].split()
        return fields[0], int(fields[2]), int(fields[3]), fields[19], int(fields[1])
    except (FileNotFoundError, ProcessLookupError):
        return None


def terminate(data):
    with open("/proc/sys/kernel/random/boot_id") as source:
        boot = source.read().strip()
    marker = ("TOUCHSTONE_DEMO_RESOURCE_NAMESPACE=" + data["namespace"]).encode() + b"\0"
    groups = data["groups"]
    held = {}

    def capture():
        members = []
        for text in os.listdir("/proc"):
            if not text.isdigit():
                continue
            pid = int(text)
            before = stat(pid)
            if before is None or before[0] == "Z":
                continue
            group = next((g for g in groups if g["boot"] == boot and before[1] == g["pid"] and before[2] == g["pid"]), None)
            if group is None:
                for key in held:
                    parent = stat(key[0]) if key[0] == before[4] else None
                    if parent and parent[3] == key[1]:
                        group = {"pid": -1, "start": "", "uid": os.getuid()}
                        break
            if group is None:
                continue
            if pid == group["pid"] and before[3] != group["start"]:
                raise RuntimeError("Producer identity was reused")
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                after = stat(pid)
                if after is None or after[3] != before[3]:
                    poll = select.poll()
                    poll.register(fd, select.POLLIN)
                    if poll.poll(0):
                        continue
                    raise RuntimeError("Producer identity changed during acquisition")
                with open(f"/proc/{pid}/environ", "rb") as source:
                    environment = source.read(1024 * 1024)
                if marker[:-1] not in environment.split(b"\0") or os.stat(f"/proc/{pid}").st_uid != group["uid"] or group["uid"] != os.getuid():
                    raise RuntimeError("Unowned process in producer session")
                key = (pid, before[3])
                if key not in held:
                    held[key] = fd
                    fd = None
                members.append((key, before[0]))
            except (FileNotFoundError, ProcessLookupError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        # Keep captured descendants even if they later change group or parent.
        present = {key for key, _ in members}
        for key, fd in held.items():
            poll = select.poll()
            poll.register(fd, select.POLLIN)
            if key not in present and not poll.poll(0):
                current = stat(key[0])
                members.append((key, current[0] if current and current[3] == key[1] else "?"))
        return members

    def send(keys, sig):
        for key in keys:
            try:
                signal.pidfd_send_signal(held[key], sig)
            except ProcessLookupError:
                pass

    try:
        members = capture()  # Validate all observed members before signaling any.
        if not members:
            time.sleep(0.01)
            members = capture()
        send([key for key, _ in members], signal.SIGTERM)
        grace = time.monotonic() + data["graceMs"] / 1000
        while members and time.monotonic() < grace:
            time.sleep(0.01)
            members = capture()
        # Freeze every remaining producer before the final snapshot. Once all
        # members are stopped, no member can fork between snapshot and SIGKILL.
        until = time.monotonic() + 2
        stable = None
        while members:
            send([key for key, _ in members], signal.SIGSTOP)
            time.sleep(0.01)
            members = capture()
            keys = frozenset(key for key, _ in members)
            if all(state in ("T", "t") for _, state in members) and keys == stable:
                break
            stable = keys
            if time.monotonic() >= until:
                raise RuntimeError("Producer session could not be frozen")
        send([key for key, _ in members], signal.SIGKILL)
        until = time.monotonic() + 2
        empty = 0
        while empty < 2:
            empty = 0 if capture() else empty + 1
            if time.monotonic() >= until:
                raise RuntimeError("Producer session did not exit")
            time.sleep(0.01)
        # pidfds remain bound to the original processes even if PIDs are reused.
        poll = select.poll()
        for fd in held.values():
            poll.register(fd, select.POLLIN)
        pending = set(held.values())
        while pending and time.monotonic() < until:
            for fd, _ in poll.poll(20):
                pending.discard(fd)
                poll.unregister(fd)
        if pending:
            raise RuntimeError("Producer exit could not be joined")
    finally:
        for fd in held.values():
            os.close(fd)


try:
    check()
    if sys.argv[1:] != ["--check"]:
        terminate(json.load(sys.stdin))
    print("ok")
except Exception:
    # Never print process environments, commands, or private journal contents.
    print("Demo producer cleanup could not be verified.", file=sys.stderr)
    sys.exit(1)
