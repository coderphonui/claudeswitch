#!/usr/bin/env python3
"""Fail if the README's command table drifts from the CLI.

Documentation that lists a command the binary does not have, or a flag it
rejects, is worse than no documentation: someone copies it and gets an error.
This keeps the table honest without anybody having to remember.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
readme = open(os.path.join(ROOT, "README.md"), encoding="utf8").read()
cli = open(os.path.join(ROOT, "src", "cli.ts"), encoding="utf8").read()

problems = []

handlers = set(re.findall(r"^  ([a-zA-Z]+): cmd", cli, re.M)) | {"use", "off"}
documented = set(re.findall(r"^\| `cs ([a-z]+)", readme, re.M)) - {"help"}
for command in sorted(documented - handlers):
    problems.append(f"README documents `cs {command}`, which the CLI does not implement")

flags_block = re.search(
    r"const FLAGS: Record<string, readonly string\[\]> = \{(.*?)\n\};", cli, re.S
)
if not flags_block:
    problems.append("could not find the FLAGS table in src/cli.ts")
else:
    declared = set(re.findall(r"^\s+\"?([a-zA-Z]+)\"?:", flags_block.group(1), re.M))
    for command in sorted(handlers - declared - {""}):
        problems.append(f"`{command}` has a handler but no FLAGS entry, so its flags are all rejected")

# Help topics referenced in prose must exist.
topics = set(re.findall(r"^  ([a-z]+): \(\) => `", cli, re.M))
for topic in sorted(set(re.findall(r"`cs help ([a-z]+)`", readme)) - topics):
    problems.append(f"README mentions `cs help {topic}`, which is not a topic")

for problem in problems:
    print(problem)
sys.exit(1 if problems else 0)
