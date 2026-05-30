#!/usr/bin/env python3
"""Diagnose or install the mimo-computer-use platform adapter.

This wrapper is intentionally stdlib-only so mimoskill can call it before a
computer-use workflow without adding Python dependencies.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "mimo-computer-use"
SERVER = PLUGIN / "server" / "index.mjs"


def run(cmd: list[str]) -> int:
    proc = subprocess.Popen(
        cmd,
        cwd=str(PLUGIN),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line, end="")
    return proc.wait()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="install the missing adapter after detection")
    parser.add_argument("--json", action="store_true", help="print raw doctor JSON only")
    args = parser.parse_args(argv)

    if not SERVER.exists():
        print(
            json.dumps(
                {
                    "ok": False,
                    "code": "plugin_missing",
                    "message": f"mimo-computer-use server not found at {SERVER}",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2

    if args.install:
        print("mimoskill: checking mimo-computer-use adapter and installing if needed...")
        return run(["node", str(SERVER), "--install-adapter"])

    code = run(["node", str(SERVER), "--doctor"])
    if args.json:
        return code
    print("")
    print("mimoskill: if diagnosis says adapter_missing, run:")
    print("  python3 mimoskill/scripts/computer_use_setup.py --install")
    return code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
