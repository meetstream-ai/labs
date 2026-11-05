#!/usr/bin/env python3
"""Static checks for the MeetStream Hermes plugin. Standard library only.

    python3 scripts/check.py            # offline checks
    python3 scripts/check.py --live     # also list the real MCP tools via `npx @meetstream/mcp`

--live starts the published MeetStream MCP server over stdio and asks it for
tools/list. That needs Node 18+ but no API key and no MeetStream network
access, because the server only needs a key when a tool is actually called.
Without --live, tool names are not cross-checked.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
PLUGIN_FIELDS = {"$schema", "name", "version", "description", "author", "homepage",
                 "repository", "license", "keywords", "extensions"}
MCP_URL = "https://mcp.meetstream.ai/mcp"
AUTH_HEADER = "Bearer ${MEETSTREAM_API_KEY}"
SKILL_NAME_RE = re.compile(r"^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$")
# Backticked identifiers that read like an action on MeetStream must be real MCP tools.
TOOL_LIKE_RE = re.compile(
    r"`(?:mcp__meetstream__)?((?:create|list|get|remove|delete|send|transcribe|schedule|"
    r"unschedule|update|join|leave|speak|play|stop|start)_[a-z_]+)`")
SECRET_PATTERNS = [
    ("MeetStream key", re.compile(r"\bms_[A-Za-z0-9]{16,}")),
    ("auth header with literal token", re.compile(r"(?:Token|Bearer)\s+(?!\$\{)[A-Za-z0-9_\-]{24,}")),
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]
# This repository must stay declarative: no bridge, socket server or audio pipeline.
TRANSPORT_RE = re.compile(
    r"\b(?:websockets?|fastify|express\(|aiohttp\.web|uvicorn|FastAPI|sendaudio|"
    r"socket_connection_url|live_audio_required|createServer)\b")
CODE_SUFFIXES = {".py", ".js", ".ts", ".mjs", ".cjs", ".go", ".rb"}
# Response fields that match TOOL_LIKE_RE but are data, not tools (transcript segment timing).
RESPONSE_FIELDS = {"start_time"}

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"  FAIL  {msg}")


def ok(msg: str) -> None:
    print(f"  ok    {msg}")


def tracked_files() -> list[Path]:
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=ROOT,
                             capture_output=True, text=True, check=True).stdout
        return [ROOT / line for line in out.splitlines() if (ROOT / line).is_file()]
    except (OSError, subprocess.CalledProcessError):
        return [p for p in ROOT.rglob("*") if p.is_file() and ".git" not in p.parts]


def load_json(name: str) -> dict:
    try:
        data = json.loads((ROOT / name).read_text())
    except (OSError, ValueError) as exc:
        fail(f"{name} does not parse: {exc}")
        return {}
    ok(f"{name} parses")
    return data


def check_manifest() -> None:
    print("plugin.json")
    before = len(failures)
    m = load_json("plugin.json")
    if not m:
        return
    if m.get("$schema") != PLUGIN_SCHEMA:
        fail("plugin.json $schema must be the Agent Plugins v1 plugin schema")
    if extra := set(m) - PLUGIN_FIELDS:
        fail(f"plugin.json has fields Hermes rejects: {sorted(extra)}")
    if m.get("name") != "meetstream":
        fail("plugin.json name must be 'meetstream'")
    if m.get("license") != "MIT":
        fail("plugin.json license must be MIT")
    if len(failures) == before:
        ok("Agent Plugins v1 shape, name 'meetstream', MIT")


def check_mcp() -> None:
    print("mcp.json")
    before = len(failures)
    c = load_json("mcp.json")
    if not c:
        return
    if set(c) != {"$schema", "mcpServers"} or c.get("$schema") != MCP_SCHEMA:
        fail("mcp.json must contain exactly $schema (Agent Plugins v1 MCP schema) and mcpServers")
    servers = c.get("mcpServers", {})
    if list(servers) != ["meetstream"]:
        fail(f"mcp.json must declare exactly one server named 'meetstream', got {list(servers)}")
    s = servers.get("meetstream", {})
    if s.get("type") != "streamable-http" or s.get("url") != MCP_URL:
        fail(f"meetstream server must be streamable-http at {MCP_URL}")
    if s.get("headers") != {"Authorization": AUTH_HEADER}:
        fail(f"meetstream headers must be exactly Authorization: {AUTH_HEADER}")
    if set(s) - {"type", "url", "headers"}:
        fail("meetstream server has fields the portable loader rejects")
    if len(failures) == before:
        ok(f"one hosted server -> {MCP_URL}, key from ${{MEETSTREAM_API_KEY}} at connect time")


def parse_frontmatter(text: str) -> dict[str, str]:
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    fm, key = {}, None
    for line in m.group(1).splitlines():
        if re.match(r"^[a-z-]+:", line):
            key, _, val = line.partition(":")
            fm[key] = val.strip()
        elif key:
            fm[key] = (fm[key] + " " + line.strip()).strip()
    if fm.get("description", "").startswith(">"):
        fm["description"] = fm["description"][1:].strip()
    return fm


def check_skills(live: tuple[set[str], set[str]] | None) -> None:
    tools, params = live if live else (None, set())
    print("skills/")
    before = len(failures)
    dirs = sorted(p for p in (ROOT / "skills").iterdir() if p.is_dir())
    if not dirs:
        fail("no skills found")
    for d in dirs:
        md = d / "SKILL.md"
        if not md.is_file():
            fail(f"{d.name}: missing SKILL.md")
            continue
        text = md.read_text()
        fm = parse_frontmatter(text)
        if fm.get("name") != d.name or not SKILL_NAME_RE.match(d.name) or len(d.name) > 64:
            fail(f"{d.name}: frontmatter name must equal the directory name")
        if not 1 <= len(fm.get("description", "")) <= 1024:
            fail(f"{d.name}: description must be 1-1024 characters")
        for target in re.findall(r"\]\((?!https?://|mailto:|#)([^)]+)\)", text):
            if not (md.parent / target).exists():
                fail(f"{d.name}: broken relative link {target}")
        if tools is not None:
            for ref in sorted(set(TOOL_LIKE_RE.findall(text))):
                if ref not in tools and ref not in params and ref not in RESPONSE_FIELDS:
                    fail(f"{d.name}: references `{ref}`, which the MeetStream MCP server does not expose")
    if len(failures) == before:
        ok(f"{len(dirs)} skills, names match directories" + (", every tool reference exists" if tools else ""))


def live_tools() -> tuple[set[str], set[str]]:
    """(tool names, every input parameter name) from the real server's tools/list."""
    print("live MCP tool list (npx @meetstream/mcp, stdio, no key)")
    npx = shutil.which("npx")
    if not npx:
        fail("--live needs npx (Node 18+)")
        return set(), set()
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "meetstream-hermes-check", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    stdin = "".join(json.dumps(m) + "\n" for m in msgs)
    # No MEETSTREAM_API_KEY is passed: tools/list must work without one.
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), "DO_NOT_TRACK": "1"}
    proc = subprocess.Popen([npx, "-y", "@meetstream/mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, env=env)
    proc.stdin.write(stdin)
    proc.stdin.flush()
    names: set[str] = set()
    params: set[str] = set()
    try:
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("id") == 2:
                tools = msg.get("result", {}).get("tools", [])
                names = {t["name"] for t in tools}
                params = {p for t in tools for p in t.get("inputSchema", {}).get("properties", {})}
                break
    finally:
        proc.kill()
    if not names:
        fail("could not read tools/list from @meetstream/mcp")
    else:
        ok(f"{len(names)} tools: {', '.join(sorted(names))}")
    return names, params


def check_secrets(files: list[Path]) -> None:
    print("secret scan")
    before = len(failures)
    for path in files:
        if path.suffix in {".png", ".jpg", ".gif", ".ico"}:
            continue
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        for label, pattern in SECRET_PATTERNS:
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                fail(f"{path.relative_to(ROOT)}:{line}: possible {label}")
        if path.name == ".env" or path.name.endswith(".env"):
            fail(f"{path.relative_to(ROOT)}: .env files must not be committed")
    if len(failures) == before:
        ok(f"{len(files)} files, no credentials found")


def check_no_transport(files: list[Path]) -> None:
    print("no duplicate meeting transport")
    before = len(failures)
    for path in files:
        if path.suffix not in CODE_SUFFIXES or path.resolve() == Path(__file__).resolve():
            continue
        for match in TRANSPORT_RE.finditer(path.read_text(errors="ignore")):
            fail(f"{path.relative_to(ROOT)}: transport/server code ({match.group(0)}) - "
                 "meeting transport belongs to MeetStream, not this plugin")
    if len(failures) == before:
        ok("no bridge, socket server or audio pipeline in this repository")


def check_hermes() -> None:
    print("hermes plugins validate / doctor")
    if not shutil.which("hermes"):
        print("  skip  hermes CLI not installed")
        return
    for cmd in (["hermes", "plugins", "validate", str(ROOT)], ["hermes", "plugins", "doctor", "--ci", str(ROOT)]):
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            fail(f"{' '.join(cmd[:3])} failed:\n{res.stdout}{res.stderr}")
        else:
            ok(" ".join(cmd[:3]))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", action="store_true", help="cross-check tool names against @meetstream/mcp")
    ap.add_argument("--no-hermes", action="store_true", help="skip hermes plugins validate/doctor")
    args = ap.parse_args()
    files = tracked_files()
    check_manifest()
    check_mcp()
    check_skills(live_tools() if args.live else None)
    check_secrets(files)
    check_no_transport(files)
    if not args.no_hermes:
        check_hermes()
    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
