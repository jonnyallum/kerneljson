#!/usr/bin/env python3
"""KJ-P2.2B: change a few named keys in a production runtime env file and
provably preserve every other line.

Exists because KJ-P2.2A's deploy path (D1 Stage 5) regenerates runtime.env as a
DATABASE_URL-only file, which would silently drop ALERT_RUNNER_ENABLED,
ALERT_RUNNER_CADENCE_MS, ALERT_STATE_STORE and the scheduler/admission settings
(the worker's compose defaults would then turn the alert runner OFF).

Rules, enforced in code, not by discipline:
  * only a fixed allow-list of keys can be set; anything else is refused
  * a secret (bot token, chat id) is read from a FILE path, never argv
  * the base file must already hold every key named by --require-keys
  * every base line not being set is copied through byte-for-byte
  * stdout carries key names, lengths and sha8 fingerprints only, never values
  * the output file is created mode 600 and an existing file is never overwritten
  * `verify` re-derives the diff from the two files themselves, independent of merge
"""
import argparse
import hashlib
import os
import re
import sys

PUBLIC_KEYS = {
    "ALERT_TRANSPORT": re.compile(r"^(console|telegram)$"),
    "KERNELJSON_RELEASE_ID": re.compile(r"^[0-9a-f]{40}$"),
    "EXPECTED_RELEASE_ID": re.compile(r"^[0-9a-f]{40}$"),
    # KJ-P3 mission runtimes: Claude analyses, Grok reviews. The family is fixed by the recipe.
    "MISSION_ANALYST_MODEL": re.compile(r"^anthropic/[A-Za-z0-9._:-]{1,80}$"),
    "MISSION_REVIEWER_MODEL": re.compile(r"^x-ai/[A-Za-z0-9._:-]{1,80}$"),
}
SECRET_KEYS = {
    "TELEGRAM_BOT_TOKEN": re.compile(r"^\d{6,12}:[A-Za-z0-9_-]{35}$"),
    "TELEGRAM_CHAT_ID": re.compile(r"^-?\d{5,20}$"),
    "MISSION_OPENROUTER_API_KEY": re.compile(r"^sk-or-v1-[A-Za-z0-9]{64}$"),
    "GITHUB_READ_TOKEN": re.compile(r"^(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})$"),
}


class Refused(Exception):
    pass


def sha8(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:8].upper()


def parse(path):
    """Return (lines, {key: value}). Duplicate keys are ambiguous, so refused."""
    with open(path, "r", encoding="utf-8", newline="") as fh:
        text = fh.read()
    if text.startswith("\ufeff"):
        raise Refused("base file starts with a BOM; refusing to guess")
    lines = text.splitlines(keepends=True)
    values = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = line.rstrip("\r\n").split("=", 1)
        if key in values:
            raise Refused("duplicate key in file: " + key)
        values[key] = value
    return lines, values


def read_secret_file(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    text = raw.decode("utf-8")
    if text.startswith("\ufeff"):
        text = text[1:]
    return text.strip()


def manifest(values, before=None):
    out = []
    for key in sorted(values):
        if before is None:
            status = "KEY"
        elif key not in before:
            status = "ADDED"
        elif before[key] == values[key]:
            status = "UNCHANGED"
        else:
            status = "CHANGED"
        out.append("%-9s %-28s len=%-4d sha8=%s" % (status, key, len(values[key]), sha8(values[key])))
    return out


def cmd_fingerprint(args):
    _, values = parse(args.file)
    print("\n".join(manifest(values)))
    return 0


def cmd_merge(args):
    lines, base = parse(args.base)
    for key in filter(None, args.require_keys.split(",")):
        if key not in base:
            raise Refused("base file is missing required key: " + key)
    if "DATABASE_URL" not in base:
        raise Refused("base file has no DATABASE_URL; refusing to treat it as a production env file")
    updates = {}
    for spec in args.set_public:
        key, _, value = spec.partition("=")
        if key in SECRET_KEYS:
            raise Refused(key + " is a secret and must come from --set-from <file>, never argv")
        if key not in PUBLIC_KEYS:
            raise Refused("key not settable by this tool: " + key)
        if not PUBLIC_KEYS[key].match(value):
            raise Refused("value for " + key + " has an unexpected shape")
        updates[key] = value
    for spec in args.set_from:
        key, _, path = spec.partition("=")
        if key not in SECRET_KEYS:
            raise Refused("key not settable from a file by this tool: " + key)
        value = read_secret_file(path)
        if not SECRET_KEYS[key].match(value):
            raise Refused("file for " + key + " does not hold a value of the expected shape")
        updates[key] = value
    if not updates:
        raise Refused("nothing to set")

    out_lines, done = [], set()
    for line in lines:
        stripped = line.strip()
        key = line.split("=", 1)[0] if stripped and not stripped.startswith("#") and "=" in stripped else None
        if key in updates:
            newline = "\r\n" if line.endswith("\r\n") else "\n"
            out_lines.append(key + "=" + updates[key] + newline)
            done.add(key)
        else:
            out_lines.append(line)
    if out_lines and not out_lines[-1].endswith("\n"):
        out_lines[-1] += "\n"
    for key in updates:
        if key not in done:
            out_lines.append(key + "=" + updates[key] + "\n")

    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
        fh.write("".join(out_lines))
    _, merged = parse(args.out)
    lost = sorted(set(base) - set(merged))
    if lost:
        os.unlink(args.out)
        raise Refused("merge would have dropped keys: " + ",".join(lost))
    print("\n".join(manifest(merged, base)))
    return 0


def cmd_verify(args):
    _, base = parse(args.base)
    _, new = parse(args.new)
    allowed = set(filter(None, args.changed.split(",")))
    problems = []
    for key in sorted(base):
        if key not in new:
            problems.append("MISSING " + key)
        elif base[key] != new[key] and key not in allowed:
            problems.append("CHANGED " + key)
    for key in sorted(set(new) - set(base)):
        if key not in allowed:
            problems.append("ADDED " + key)
    print("\n".join(manifest(new, base)))
    if problems:
        print("VERIFY FAILED: " + "; ".join(problems), file=sys.stderr)
        return 1
    print("VERIFY OK: every key outside {%s} is identical to the baseline" % ",".join(sorted(allowed)))
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("fingerprint")
    p.add_argument("file")
    p.set_defaults(fn=cmd_fingerprint)
    p = sub.add_parser("merge")
    p.add_argument("--base", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--require-keys", default="")
    p.add_argument("--set-public", action="append", default=[])
    p.add_argument("--set-from", action="append", default=[])
    p.set_defaults(fn=cmd_merge)
    p = sub.add_parser("verify")
    p.add_argument("--base", required=True)
    p.add_argument("--new", required=True)
    p.add_argument("--changed", default="")
    p.set_defaults(fn=cmd_verify)
    args = parser.parse_args(argv)
    try:
        return args.fn(args)
    except Refused as err:
        print("REFUSED: " + str(err), file=sys.stderr)
        return 2
    except ValueError:
        # UnicodeDecodeError: fixed text, never the offending bytes.
        print("REFUSED: file is not valid UTF-8", file=sys.stderr)
        return 2
    except OSError as err:
        # errno text only: never str(err), which can carry a path or content.
        print("REFUSED: file error (errno %s)" % err.errno, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
