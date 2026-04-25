#!/usr/bin/env python3
"""Template SOUP monitoring helper."""

from __future__ import annotations

import json
import sys


def main() -> int:
    request = json.load(sys.stdin)
    payload = request.get("payload", {})
    item_ids = payload.get("item_ids", [])
    items = []
    for item_id in item_ids:
        items.append(
            {
                "id": item_id,
                "state": "unavailable",
                "helper": "monitor",
                "unavailable_reason": "Template helper not yet customized for this repository.",
                "highlights": [
                    "Wire discovery first and validate it with 'pln soup sync' before relying on monitor output.",
                    (
                        "Customize dev/scripts/soup/monitor.py to check release feeds, "
                        "advisories, changelogs, or other project-relevant change sources."
                    ),
                ],
            }
        )
    json.dump({"items": items}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
