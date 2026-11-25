# Feasibility scan: every locked npm package in a lockfile, checked against OSV (free, read-only).
# Usage: python3 -I scan.py <label> <lockfile> [<lockfile> ...]
import json, re, sys, urllib.request

def pnpm_packages(text):
    found = set()
    in_packages = False
    for line in text.splitlines():
        if line.startswith("packages:") or line.startswith("snapshots:"):
            in_packages = True
            continue
        if in_packages and re.match(r"^\S", line):
            in_packages = False
        m = re.match(r"^  '?(@?[^@\s']+)@([0-9][^(':\s]*)", line) if in_packages else None
        if m:
            found.add((m.group(1), m.group(2)))
    return found

def yarn_packages(text):
    found = set()
    current = []
    for line in text.splitlines():
        if line and not line.startswith(" ") and line.endswith(":"):
            current = [re.match(r'"?(@?[^@"]+)@', s.strip()).group(1) for s in line[:-1].split(",") if re.match(r'"?(@?[^@"]+)@', s.strip())]
        m = re.match(r'^  version "?([^"]+)"?', line)
        if m and current:
            for name in set(current):
                found.add((name, m.group(1)))
            current = []
    return found

def osv_batch(pkgs):
    pkgs = sorted(pkgs)
    vulns = {}
    for i in range(0, len(pkgs), 500):
        chunk = pkgs[i:i + 500]
        body = json.dumps({"queries": [{"package": {"name": n, "ecosystem": "npm"}, "version": v} for n, v in chunk]}).encode()
        req = urllib.request.Request("https://api.osv.dev/v1/querybatch", data=body, headers={"Content-Type": "application/json"})
        res = json.load(urllib.request.urlopen(req, timeout=60))
        for (n, v), r in zip(chunk, res["results"]):
            ids = [x["id"] for x in r.get("vulns", [])]
            if ids:
                vulns[(n, v)] = ids
    return vulns

label, files = sys.argv[1], sys.argv[2:]
pkgs = set()
for f in files:
    text = open(f).read()
    pkgs |= pnpm_packages(text) if f.endswith(".yaml") else yarn_packages(text)
vulns = osv_batch(pkgs)
solana = sorted((n, v) for n, v in pkgs if n.startswith("@solana/") or n.startswith("@coral-xyz/") or n.startswith("@anchor-lang/"))
mal = {k: ids for k, ids in vulns.items() if any(i.startswith("MAL-") for i in ids)}
print(f"== {label}: {len(pkgs)} locked package versions, {len(vulns)} with OSV advisories, {len(mal)} flagged malicious")
for (n, v), ids in sorted(vulns.items())[:40]:
    print(f"   {n}@{v}: {', '.join(ids[:4])}{' …' if len(ids) > 4 else ''}")
key = [f"{n}@{v}" for n, v in solana if n in ("@solana/web3.js", "@coral-xyz/anchor", "@solana/spl-token", "@solana/kit", "@solana/wallet-adapter-base")]
print("   key Solana packages:", ", ".join(key[:20]))
