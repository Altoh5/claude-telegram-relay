#!/usr/bin/env python3
"""
PostToolUse hook: Run TypeScript type-check after editing .ts files.
Reports errors back to Claude so it can fix them immediately.
"""
import sys
import json
import subprocess

data = json.load(sys.stdin)
fp = data.get("tool_input", {}).get("file_path", "")

if not fp or not fp.endswith(".ts") or "node_modules" in fp:
    sys.exit(0)

result = subprocess.run(
    ["npx", "tsc", "--noEmit", "--pretty"],
    capture_output=True,
    text=True,
)

if result.returncode != 0:
    output = (result.stdout + result.stderr).strip()
    print(f"TypeScript errors in {fp}:\n{output[:800]}")
    sys.exit(1)  # exit 1 = allow but surface feedback to Claude
