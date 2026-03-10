#!/usr/bin/env python3
"""
PreToolUse hook: Block direct edits to .env files.
Claude should edit .env.example instead; .env is managed manually.
"""
import sys
import json

data = json.load(sys.stdin)
fp = data.get("tool_input", {}).get("file_path", "")
name = fp.split("/")[-1] if fp else ""

protected = name == ".env" or (
    name.startswith(".env.") and name not in {".env.example", ".env.test"}
)

if protected:
    print(f"BLOCKED: Direct edits to '{fp}' are not allowed.")
    print("Reason: .env contains live secrets. Edit .env.example for templates, or update .env manually.")
    sys.exit(2)
