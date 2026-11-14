#!/usr/bin/env python3
"""Owner terminal only. Never installed as a model or private-transport action."""
from pathlib import Path
import re
import sys
import driver


def read_line(prompt):
    print(prompt, end="", flush=True)
    value = sys.stdin.readline(256)
    if not value.endswith("\n"):
        raise ValueError("bounded input")
    return value.rstrip("\r\n")


def main():
    try:
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            raise ValueError("interactive owner terminal required")
        directory = Path(__file__).resolve().parent
        lease = directory.name.removeprefix("touchstone-wallet-")
        state = driver.checked(directory, lease)
        address = read_line("Wallet address shown in the current funding ask: ")
        amount = read_line("Exact desired offline balance, in wei: ")
        if address != state["address"] or not re.fullmatch(r"[1-9][0-9]{0,77}", amount) or int(amount) >= 2**256:
            raise ValueError("invalid address or balance")
        print(f"Offline local chain {driver.CHAIN}. Address {address}. Set exact balance to {amount} wei.")
        if read_line("Type literal done to approve this exact offline funding: ") != "done":
            print("Cancelled. No funding action taken.")
            return
        result = driver.operator_fund(directory, address, amount, True)
        print(f"Verified balance: {result['balance_wei']} wei on offline chain {result['chain_id']}.")
    except Exception:
        print("Offline operator funding failed. No verified success; check the current wallet ask.")
        sys.exit(1)


if __name__ == "__main__":
    main()
