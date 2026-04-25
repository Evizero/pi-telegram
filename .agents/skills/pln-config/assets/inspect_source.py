#!/usr/bin/env python3
"""Template SOUP source-inspection helper."""

from __future__ import annotations

import json
import sys


def main() -> int:
    request = json.load(sys.stdin)
    payload = request.get("payload", {})
    response = {
        "item_id": payload.get("item_id", ""),
        "audit_basis": payload.get("audit_basis", ""),
        "version": payload.get("version", ""),
        "audited_from_version": payload.get("audited_from_version", ""),
        "requested_target_version": payload.get("requested_target_version", ""),
        "scope": payload.get("scope", ""),
        "summary": "Customize dev/scripts/soup/inspect_source.py for bounded source inspection.",
        "findings": [],
        "notes": [
            "Reuse the same JSON stdin/stdout contract so pln can preserve review context around this helper.",
            "Inspect exact version tags or archives rather than floating HEAD where possible.",
            "Stage transient downloads and unpacked artifacts outside the repository by default.",
            "For baseline audits, prepare the whole reviewed package/codebase as broadly as practical.",
            "For update audits, prepare real comparison inputs from audited_from_version to requested_target_version when practical.",
            "When you keep bounded proof-of-work, package it under dev/soup/evidence/ and pass back only stable bundle names to review metadata.",
            "Preserve suspicious patterns or no-findings-in-reviewed-scope honestly.",
        ],
        "prepared_inspection_paths": [],
        "preserved_bundle_paths": [],
        "unresolved_states": [
            "No temp-workspace source inspection paths were prepared by the template helper.",
            "No preserved evidence bundle was created by the template helper.",
        ],
    }
    json.dump(response, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
