#!/usr/bin/env python3
"""Template SOUP discovery helper."""

from __future__ import annotations

import json
import sys


def main() -> int:
    request = json.load(sys.stdin)
    payload = request.get("payload", {})
    include_dev = bool(payload.get("include_dev", False))
    response = {
        "items": [],
        "notes": [
            "This is the first SOUP helper template to customize for a new repository.",
            "Customize dev/scripts/soup/discover.py for this repository.",
            (
                "Each discovered item must include id, name, current_version, "
                "project_relevance, role, exposure, and monitoring_basis.{source_kind,source_location}."
            ),
            (
                "Read the real manifests, lockfiles, bundled outputs, or vendored code that "
                "define externally sourced components here."
            ),
            (
                "pln writes one JSON request object to stdin and expects one JSON response "
                "object on stdout so repository-specific discovery can plug into CLI-owned "
                "SOUP workflows."
            ),
            f"include_dev={str(include_dev).lower()} is available as an example toggle.",
        ],
    }
    json.dump(response, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
