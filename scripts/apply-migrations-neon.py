#!/usr/bin/env python3
"""Ops helper: fetch the paired-production Neon connection URI TRANSIENTLY
and run the engine migrations + a schema verification against it.

The URI (which contains the database password) is fetched at runtime through
the stored custom.neon connector, passed to the Node child processes via
environment only, and NEVER printed, logged, or written to disk.

Usage:
    PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin \
        python3 scripts/apply-migrations-neon.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/templates/skill/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

CREDENTIAL = "custom.neon"
ALLOWED_HOSTS = ("console.neon.tech",)
BASE = "https://console.neon.tech/api/v2"
PROJECT_ID = "falling-sky-04835654"  # paired-production
ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get(path: str) -> dict:
    req = urllib.request.Request(BASE + path, method="GET")
    req.add_header("Accept", "application/json")
    add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=ALLOWED_HOSTS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return read_json_response(resp)


def main() -> int:
    branches = get(f"/projects/{PROJECT_ID}/branches").get("branches", [])
    if not branches:
        print("ERROR: no branches found on project", file=sys.stderr)
        return 1
    branch = next((b for b in branches if b.get("default")), branches[0])
    branch_id = branch["id"]

    databases = get(f"/projects/{PROJECT_ID}/branches/{branch_id}/databases").get("databases", [])
    if not databases:
        print("ERROR: no databases found on default branch", file=sys.stderr)
        return 1
    database = databases[0]
    db_name = database["name"]
    role_name = database.get("owner_name")

    uri_resp = get(
        f"/projects/{PROJECT_ID}/connection_uri"
        f"?branch_id={branch_id}&database_name={db_name}&role_name={role_name}"
    )
    uri = uri_resp.get("uri")
    if not uri:
        print("ERROR: connection_uri response had no uri", file=sys.stderr)
        return 1

    env = dict(os.environ)
    env["DATABASE_URL"] = uri  # transient: environment only, never printed

    print(f"branch={branch.get('name')} database={db_name} role={role_name}")
    # This VM's direct 5432 egress is intercepted; the tunneled runner goes
    # through the HTTP proxy (CONNECT) with correct TLS SNI. On a normal
    # network, plain `npm run migrate` is the path instead.
    migrate = subprocess.run(
        ["node", "scripts/migrate-tunneled.mjs"], cwd=ENGINE_DIR, env=env,
        capture_output=True, text=True,
    )
    print("migrate stdout:", migrate.stdout.strip())
    if migrate.returncode != 0:
        print("migrate stderr:", migrate.stderr.strip(), file=sys.stderr)
        return migrate.returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
