#!/usr/bin/env python3
"""Print any flag read with flagString() but missing from VALUE_FLAGS.

A missing entry is not a type error and not a crash: the flag's value is parsed
as a positional argument and the caller quietly uses its default. `--every-days
14` scheduling a 7-day interval and reporting success is what this guards.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")

args_ts = open(os.path.join(SRC, "core", "args.ts"), encoding="utf8").read()
block = re.search(r"VALUE_FLAGS = new Set\(\[(.*?)\]\)", args_ts, re.S)
declared = set(re.findall(r'"([A-Za-z]+)"', block.group(1))) if block else set()

used = set()
for dirpath, _dirs, files in os.walk(SRC):
    for name in files:
        if name.endswith(".ts"):
            text = open(os.path.join(dirpath, name), encoding="utf8").read()
            used |= set(re.findall(r'flagString\(args,\s*"([A-Za-z]+)"\)', text))

missing = sorted(used - declared)
print(",".join(missing))
sys.exit(1 if missing else 0)
