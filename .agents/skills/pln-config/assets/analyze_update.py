#!/usr/bin/env python3
"""Template SOUP update-analysis helper."""

from __future__ import annotations

import json
import sys


def main() -> int:
    request = json.load(sys.stdin)
    payload = request.get("payload", {})
    response = {
        "item_id": payload.get("item_id", ""),
        "audit_basis": payload.get("audit_basis", ""),
        "from_version": payload.get("from_version", ""),
        "to_version": payload.get("to_version", ""),
        "audited_from_version": payload.get("audited_from_version", ""),
        "requested_target_version": payload.get("requested_target_version", ""),
        "summary": "Customize dev/scripts/soup/analyze_update.py for project-specific update analysis.",
        "highlights": [
            "This helper keeps the same JSON stdin/stdout seam as discover.py and monitor.py.",
            "Fetch release notes, changelog entries, or diff metadata for the exact requested target.",
            "When audit_basis is update, prepare comparison inputs from audited_from_version to requested_target_version.",
            "Summarize likely breaking changes and project-specific impact before deciding.",
        ],
        "prepared_inspection_paths": [],
        "preserved_bundle_paths": [],
        "unresolved_states": [
            "No local temp-workspace inspection paths were prepared by the template helper.",
            "No preserved evidence bundle was created by the template helper.",
        ],
    }
    json.dump(response, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
