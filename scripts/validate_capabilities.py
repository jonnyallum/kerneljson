#!/usr/bin/env python3
"""
Capability-catalogue validator (KernelJSON prep, review 2026-09-07).

Treats capabilities/INDEX.yaml + the per-capability manifests as executable
constitutional metadata, not documentation. Run in CI on every change.

Checks:
  - YAML syntax parses for INDEX + every manifest
  - INDEX `count` == number of INDEX entries == number of manifest files on disk
  - every INDEX path exists; every manifest is referenced by INDEX
  - ids unique; manifest id == INDEX id for each path
  - runtime enum valid (INDEX + manifest)
  - status enum valid, and INDEX status == manifest status
  - side_effects is an ARRAY everywhere (never a string), every value in the enum
  - evidence_produced present with a `format` and either `fields` or `guarantee`

Exit 0 = all pass; 1 = one or more failures.
"""
import sys
import pathlib

try:
    import yaml
except ImportError:
    print("FAIL: PyYAML not installed (pip install pyyaml)")
    sys.exit(1)

ROOT = pathlib.Path(__file__).resolve().parent.parent
CAPS = ROOT / "capabilities"
INDEX = CAPS / "INDEX.yaml"

STATUS_ENUM = {"enabled", "staged", "candidate", "legacy", "retired"}
RUNTIME_ENUM = {
    "spawner-runtime", "gvisor-sandbox", "conductor-mcp", "supabase-mcp", "mcp-web",
    "openclaw-gateway", "whatsapp-cloud-api", "boardroom-dsp", "deepseek-runtime",
    "mcp-browser", "resend-mcp", "social-scheduler", "elevenlabs-mcp", "n8n",
}
# Controlled side-effect vocabulary. Adding a new effect is a deliberate act:
# add it here in the same change that introduces it.
SIDE_EFFECT_ENUM = {
    "write-filesystem", "git-commit", "github-pr-create", "github-branch-push",
    "write-db", "schema-migration", "outbound-http", "isolated-compute",
    "ephemeral-worker-lifecycle", "outbound-notification", "graph-interrupt",
    "outbound-email", "external-spend", "browser-automation", "public-content-publish",
    "audio-artefact", "workflow-execution", "declared-per-workflow",
    "atomic-claim", "brain-read", "brain-write",
}

errors = []


def err(msg):
    errors.append(msg)


def load_yaml(p):
    try:
        with open(p, encoding="utf-8") as f:
            return yaml.safe_load(f)
    except Exception as e:  # noqa: BLE001
        err(f"YAML parse error in {p.relative_to(ROOT)}: {e}")
        return None


def check_side_effects(cid, where, value):
    if not isinstance(value, list):
        err(f"{cid}: {where} side_effects must be an array, got {type(value).__name__} ({value!r})")
        return
    for s in value:
        if s not in SIDE_EFFECT_ENUM:
            err(f"{cid}: {where} side_effect '{s}' not in the controlled enum")


idx = load_yaml(INDEX)
if not isinstance(idx, dict) or "capabilities" not in idx:
    err("INDEX.yaml missing or has no 'capabilities' list")
    print("FAIL:\n  - " + "\n  - ".join(errors))
    sys.exit(1)

entries = idx["capabilities"]
declared_count = idx.get("count")
manifests = sorted(p for p in CAPS.rglob("*.yaml") if p.name != "INDEX.yaml")

if declared_count != len(entries):
    err(f"INDEX count field ({declared_count}) != number of INDEX entries ({len(entries)})")
if len(entries) != len(manifests):
    err(f"INDEX entries ({len(entries)}) != manifest files on disk ({len(manifests)})")

index_ids = set()
manifest_ids = set()
referenced = set()

for e in entries:
    cid = e.get("id", "<no-id>")
    if cid in index_ids:
        err(f"duplicate id in INDEX: {cid}")
    index_ids.add(cid)

    if e.get("runtime") not in RUNTIME_ENUM:
        err(f"{cid}: INDEX runtime '{e.get('runtime')}' not in enum")
    if e.get("status") not in STATUS_ENUM:
        err(f"{cid}: INDEX status '{e.get('status')}' not in enum")
    check_side_effects(cid, "INDEX", e.get("side_effects"))

    path = e.get("path")
    if not path:
        err(f"{cid}: INDEX entry has no path")
        continue
    referenced.add(str((ROOT / path).resolve()))
    mp = ROOT / path
    if not mp.exists():
        err(f"{cid}: INDEX path does not exist: {path}")
        continue

    m = load_yaml(mp)
    if m is None:
        continue
    mid = m.get("id")
    if mid != cid:
        err(f"{cid}: manifest id '{mid}' != INDEX id (path {path})")
    if mid in manifest_ids:
        err(f"duplicate manifest id: {mid}")
    manifest_ids.add(mid)

    if m.get("runtime") not in RUNTIME_ENUM:
        err(f"{cid}: manifest runtime '{m.get('runtime')}' not in enum")
    if m.get("status") not in STATUS_ENUM:
        err(f"{cid}: manifest status '{m.get('status')}' not in enum")
    if m.get("status") != e.get("status"):
        err(f"{cid}: manifest status '{m.get('status')}' != INDEX status '{e.get('status')}'")
    check_side_effects(cid, "manifest", m.get("side_effects"))

    ev = m.get("evidence_produced")
    if not isinstance(ev, dict) or "format" not in ev:
        err(f"{cid}: evidence_produced missing or has no 'format'")
    elif not any(k in ev for k in ("fields", "guarantee")):
        err(f"{cid}: evidence_produced has neither 'fields' nor 'guarantee'")

for mp in manifests:
    if str(mp.resolve()) not in referenced:
        err(f"manifest not referenced by INDEX: {mp.relative_to(ROOT)}")

if errors:
    print(f"FAIL: {len(errors)} problem(s):")
    for x in errors:
        print(f"  - {x}")
    sys.exit(1)

print(f"OK: capability catalogue valid - {len(entries)} capabilities, "
      f"{len(manifests)} manifests, counts consistent, enums clean.")
sys.exit(0)
