#!/usr/bin/env python3
"""Serialize COBOL and atomically publish closed indexed files as one generation.

The immutable generation contains account files, the processed-reference journal,
input, results and balances. A single durable symlink replacement commits them.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid


def sync_dir(path):
    fd = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_balances(path):
    items = []
    for line in path.read_text().splitlines():
        kind = line[24:25]
        if len(line) != 25 or kind not in ("C", "E", "c", "e"):
            raise ValueError("Unrecognized account type/state")
        items.append({"account": line[:12], "amountMinor": int(line[12:24]),
            "currency": "ZAR", "kind": "CLIENT" if kind.upper() == "C" else "EMPLOYEE",
            "state": "ACTIVE" if kind.isupper() else "SUSPENDED"})
    if sum(item["amountMinor"] for item in items) != 10000000:
        raise ValueError("Seeded demo total must remain conserved")
    return items


def execute(root, mode, source=None, fault=None):
    root.mkdir(parents=True, exist_ok=True)
    with (root / "core.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = root / "current"
        if not current.exists():
            build(root, "SEED")
        elif json.loads((current / "manifest.json").read_text()).get("formatVersion",1) < 2:
            build(root,"UPGRADE")
        if mode == "SEED":
            return {"generation": str(current.resolve())}
        if mode == "SNAPSHOT":
            manifest = json.loads((current / "manifest.json").read_text())
            return {"generation": current.resolve().name,
                    "sequence": manifest.get("sequence",0),
                    "observedAt": manifest.get("observedAt", datetime.fromtimestamp(
                        (current / "manifest.json").stat().st_mtime, timezone.utc).isoformat()),
                    "balances": read_balances(current / "balances.dat")}
        return build(root, mode, source, fault)


def build(root, mode, source=None, fault=None):
    generation = root / ("gen-" + uuid.uuid4().hex)
    generation.mkdir()
    if mode != "SEED":
        for path in (root / "current").resolve().iterdir():
            if path.name.startswith(("accounts.idx", "journal.idx")):
                shutil.copyfile(path, generation / path.name)
        if mode not in ("AUDIT","UPGRADE"):
            data = Path(source).read_bytes()
            rows = data.splitlines()
            if not rows or any(len(row) != 75 for row in rows):
                raise ValueError("Every input row must contain exactly 75 ASCII bytes")
            for row in rows:
                row.decode("ascii")
                if not row[60:72].isdigit():
                    raise ValueError("Invalid minor-unit amount")
            (generation / "input.dat").write_bytes(data)
    binary = os.environ.get("CORE_BINARY", "/app/core")
    subprocess.run([binary], cwd=generation, env={**os.environ, "CORE_MODE": mode},
                   check=True, timeout=30, stdout=subprocess.DEVNULL)
    result = {"generation": str(generation), "records": [], "balances": []}
    if mode not in ("SEED","UPGRADE"):
        output = (generation / "output.dat").read_text().splitlines()
        if mode != "AUDIT" and len(output) != len(rows):
            raise ValueError("Core output row count differs from input")
        for index, line in enumerate(output):
            line = line.ljust(139)  # LINE SEQUENTIAL strips trailing spaces.
            if len(line) != 139 or (mode != "AUDIT" and line[:36] != rows[index][:36].decode()):
                raise ValueError("Core output reference/width mismatch")
            result["records"].append({"reference": line[:36], "sourceAccount": line[36:48],
                "targetAccount": line[48:60], "amountMinor": int(line[60:72]),
                "currency": line[72:75], "status": line[75:83].strip(),
                "reason": line[83:103].strip(), "postingId": line[103:139].strip() or None})
    result["balances"] = read_balances(generation / "balances.dat")
    if mode in ("QUERY", "AUDIT"):
        shutil.rmtree(generation)
        current = (root / "current").resolve()
        result["generation"] = current.name
        manifest = json.loads((current / "manifest.json").read_text())
        result["observedAt"] = manifest.get("observedAt", datetime.fromtimestamp(
            (current / "manifest.json").stat().st_mtime, timezone.utc).isoformat())
        result["truncated"] = len(result["records"]) > 5000
        result["records"] = result["records"][:5000]
        return result
    result["generation"] = generation.name
    observed_at = datetime.now(timezone.utc).isoformat()
    sequence = 0 if mode == "SEED" else json.loads((root / "current/manifest.json").read_text()).get("sequence",0)+1
    (generation / "manifest.json").write_text(json.dumps({"mode": mode,
        "formatVersion": 2,
        "observedAt": observed_at,
        "sequence": sequence,
        "inputSha256": hashlib.sha256((generation / "input.dat").read_bytes()).hexdigest()
            if mode not in ("SEED","UPGRADE") else None, "result": result}, indent=2))
    for path in generation.iterdir():
        with path.open("rb") as handle:
            os.fsync(handle.fileno())
    sync_dir(generation)
    sync_dir(root)
    if fault == "before-commit":
        raise RuntimeError("Injected failure before publishing generation")
    temporary = root / ("current-" + uuid.uuid4().hex)
    temporary.symlink_to(generation.name)
    os.replace(temporary, root / "current")
    sync_dir(root)
    if fault == "after-commit":
        raise RuntimeError("Injected failure after publishing generation")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["SEED", "POST", "QUERY", "AUDIT", "SNAPSHOT", "UPGRADE"])
    parser.add_argument("source", nargs="?")
    parser.add_argument("--fault", choices=["before-commit", "after-commit"])
    args = parser.parse_args()
    print(json.dumps(execute(Path(os.environ.get("CORE_ROOT", "/data/core")),
                             args.mode, args.source, args.fault)))
