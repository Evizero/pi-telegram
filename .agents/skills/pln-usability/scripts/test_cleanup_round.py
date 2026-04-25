#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).with_name("cleanup_round.py")
SPEC = importlib.util.spec_from_file_location("cleanup_round", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
cleanup_round = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup_round)


class CleanupRoundTests(unittest.TestCase):
    def make_round(self, root: Path, name: str = "01-test") -> Path:
        round_dir = root / "dev" / "usability" / "evidence" / "rounds" / name
        round_dir.mkdir(parents=True)
        return round_dir

    def add_scenario(self, round_dir: Path, name: str) -> Path:
        scenario_dir = round_dir / name
        (scenario_dir / "workspace").mkdir(parents=True)
        (scenario_dir / "ux_observation.md").write_text(f"# {name}\n", encoding="utf-8")
        return scenario_dir

    def test_validate_preserves_unrelated_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            round_dir = self.make_round(root)
            self.add_scenario(round_dir, "01-a")
            (round_dir / "screenshots").mkdir()
            (round_dir / "screenshots" / "shot.txt").write_text("shot\n", encoding="utf-8")

            scenario_dirs, preserved_dirs = cleanup_round.validate_round_dir(round_dir)

            self.assertEqual([path.name for path in scenario_dirs], ["01-a"])
            self.assertEqual([path.name for path in preserved_dirs], ["screenshots"])

    def test_validate_rejects_incomplete_numbered_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            round_dir = self.make_round(root)
            self.add_scenario(round_dir, "01-a")
            (round_dir / "02-b").mkdir()
            (round_dir / "02-b" / "notes.txt").write_text("incomplete\n", encoding="utf-8")

            with self.assertRaises(cleanup_round.CleanupError):
                cleanup_round.validate_round_dir(round_dir)

    def test_flatten_round_in_place_preserves_round_level_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            round_dir = self.make_round(root)
            self.add_scenario(round_dir, "01-a")
            (round_dir / "screenshots").mkdir()
            (round_dir / "screenshots" / "shot.txt").write_text("shot\n", encoding="utf-8")

            scenario_dirs, _ = cleanup_round.validate_round_dir(round_dir)
            flattened = cleanup_round.flatten_round_in_place(round_dir, scenario_dirs)

            self.assertEqual(flattened, ["01-a.md"])
            self.assertTrue((round_dir / "01-a.md").is_file())
            self.assertFalse((round_dir / "01-a").exists())
            self.assertTrue((round_dir / "screenshots" / "shot.txt").is_file())

    def test_validate_accepts_native_round_layout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            round_dir = self.make_round(root)
            self.add_scenario(round_dir, "01-a")

            scenario_dirs, preserved_dirs = cleanup_round.validate_round_dir(round_dir)

            self.assertEqual([path.name for path in scenario_dirs], ["01-a"])
            self.assertEqual(preserved_dirs, [])

    def test_validate_rejects_non_native_round_layout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            round_dir = root / "rounds" / "01-a"
            round_dir.mkdir(parents=True)
            self.add_scenario(round_dir, "01-a")

            with self.assertRaises(cleanup_round.CleanupError):
                cleanup_round.validate_round_dir(round_dir)

    def test_main_creates_archive_and_flattens_round(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            round_dir = self.make_round(root)
            self.add_scenario(round_dir, "01-a")
            (round_dir / "ux_report.md").write_text("report\n", encoding="utf-8")
            with tempfile.TemporaryDirectory() as archive_tmp:
                archive_root = Path(archive_tmp)
                result = subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        str(SCRIPT_PATH),
                        str(round_dir),
                        "--temp-root",
                        str(archive_root),
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((round_dir / "01-a.md").is_file())
                self.assertFalse((round_dir / "01-a").exists())
                self.assertTrue((archive_root / "pln-usability-round-01-test.zip").is_file())


if __name__ == "__main__":
    unittest.main()
