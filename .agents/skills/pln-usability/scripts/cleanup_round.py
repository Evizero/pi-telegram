#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

USABILITY_RECORD_DIRS = ("rounds",)


class CleanupError(RuntimeError):
    pass


def os_access_writable(path: Path) -> bool:
    try:
        test_file = path / f".cleanup-round-write-check-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        test_file.write_text("ok\n", encoding="utf-8")
        test_file.unlink()
        return True
    except OSError:
        return False


def path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def find_repo_root(start: Path) -> Path | None:
    for candidate in [start, *start.parents]:
        if (candidate / ".git").exists():
            return candidate
    return None


def inferred_repo_root_from_round_dir(round_dir: Path) -> Path | None:
    if is_native_round_dir(round_dir):
        return round_dir.parent.parent.parent.parent.parent
    return None


def choose_temp_root(
    explicit: str | None, *, require_writable: bool, repo_root: Path | None
) -> Path:
    if explicit:
        root = Path(explicit).expanduser().resolve()
        if not root.is_dir():
            raise CleanupError(f"Temp root does not exist or is not a directory: {root}")
        if repo_root is not None and path_is_within(root, repo_root):
            raise CleanupError(f"Temp root must be outside the repository: {root}")
        if require_writable and not os_access_writable(root):
            raise CleanupError(f"Temp root is not writable: {root}")
        return root

    candidates = [Path("/var/tmp").resolve(), Path(tempfile.gettempdir()).resolve()]
    for root in candidates:
        if not root.is_dir():
            continue
        if repo_root is not None and path_is_within(root, repo_root):
            continue
        if require_writable and not os_access_writable(root):
            continue
        return root

    raise CleanupError("Could not find a usable system temp directory outside the repository")


def choose_archive_path(temp_root: Path, round_name: str) -> Path:
    base = temp_root / f"pln-usability-round-{round_name}.zip"
    if not base.exists():
        return base

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = temp_root / f"pln-usability-round-{round_name}-{timestamp}.zip"
    counter = 1
    while candidate.exists():
        candidate = temp_root / f"pln-usability-round-{round_name}-{timestamp}-{counter}.zip"
        counter += 1
    return candidate


def is_native_round_dir(round_dir: Path) -> bool:
    return (
        round_dir.parent.name == "rounds"
        and round_dir.parent.parent.name == "evidence"
        and round_dir.parent.parent.parent.name == "usability"
        and round_dir.parent.parent.parent.parent.name == "dev"
    )


def archive_round(round_dir: Path, archive_path: Path) -> None:
    if is_native_round_dir(round_dir):
        archive_root = round_dir.parent.parent.parent.parent.parent
    else:
        archive_root = round_dir.parent.parent.parent
    with ZipFile(archive_path, "w", compression=ZIP_DEFLATED) as zf:
        for path in sorted(round_dir.rglob("*")):
            try:
                arcname = path.relative_to(archive_root).as_posix()
            except ValueError:
                arcname = path.name

            if path.is_dir():
                zf.writestr(f"{arcname.rstrip('/')}/", "")
            else:
                zf.write(path, arcname)


def is_numbered_name(name: str) -> bool:
    return re.match(r"^\d+-", name) is not None


def is_raw_scenario_dir(path: Path) -> bool:
    return (
        path.is_dir() and (path / "ux_observation.md").is_file() and (path / "workspace").is_dir()
    )


def classify_round_children(round_dir: Path) -> tuple[list[Path], list[Path], list[Path]]:
    scenario_dirs: list[Path] = []
    incomplete_dirs: list[Path] = []
    preserved_dirs: list[Path] = []

    for child in sorted(round_dir.iterdir()):
        if not child.is_dir():
            continue
        if is_raw_scenario_dir(child):
            scenario_dirs.append(child)
        elif is_numbered_name(child.name):
            incomplete_dirs.append(child)
        else:
            preserved_dirs.append(child)

    return scenario_dirs, incomplete_dirs, preserved_dirs


def validate_round_dir(round_dir: Path, *, force: bool = False) -> tuple[list[Path], list[Path]]:
    if not round_dir.is_dir():
        raise CleanupError(f"Round directory does not exist: {round_dir}")

    if round_dir.name == "rounds":
        raise CleanupError(
            "Refusing to clean the rounds root. Pass a single raw round directory such as "
            "dev/usability/evidence/rounds/01-initial."
        )

    native_layout = is_native_round_dir(round_dir)
    if not native_layout:
        raise CleanupError(
            "Refusing to clean a directory outside "
            f"dev/usability/evidence/rounds/<round>: {round_dir}"
        )

    flattened_files = [
        child.name
        for child in sorted(round_dir.iterdir())
        if child.is_file() and child.suffix == ".md" and is_numbered_name(child.name)
    ]
    if flattened_files and not force:
        lines = "\n".join(f"- {name}" for name in flattened_files)
        raise CleanupError(
            f"Refusing to clean up because the round already looks partially flattened:\n{lines}\n"
            "Use --force to proceed anyway (only raw scenario directories will be flattened)."
        )

    scenario_dirs, incomplete_dirs, preserved_dirs = classify_round_children(round_dir)
    if incomplete_dirs:
        lines = "\n".join(f"- {path.name}" for path in incomplete_dirs)
        raise CleanupError(
            "Refusing to clean up because these numbered directories do not match the raw "
            "scenario layout (they must contain both ux_observation.md and workspace/):\n"
            f"{lines}"
        )

    if not scenario_dirs:
        raise CleanupError(
            "No raw scenario directories found. Pass a raw round directory whose direct child "
            "directories contain both ux_observation.md and workspace/."
        )

    collisions = [
        round_dir / f"{scenario_dir.name}.md"
        for scenario_dir in scenario_dirs
        if (round_dir / f"{scenario_dir.name}.md").exists()
    ]
    if collisions:
        lines = "\n".join(f"- {path}" for path in collisions)
        raise CleanupError(
            f"Refusing to flatten because one or more target markdown files already exist:\n{lines}"
        )

    return scenario_dirs, preserved_dirs


def flatten_round_in_place(
    round_dir: Path,
    scenario_dirs: list[Path],
    *,
    repo_root: Path | None = None,
    rewrites: dict[str, str] | None = None,
) -> list[str]:
    flattened: list[str] = []

    for scenario_dir in scenario_dirs:
        observation = scenario_dir / "ux_observation.md"
        target = round_dir / f"{scenario_dir.name}.md"

        for child in sorted(path for path in scenario_dir.rglob("*") if path.is_file()):
            if child == observation:
                continue
            rewrite_target: Path | None = None
            if repo_root is not None and rewrites:
                try:
                    child_key = child.relative_to(repo_root).as_posix()
                except ValueError:
                    child_key = None
                if child_key is not None and child_key in rewrites:
                    rewrite_target = repo_root / rewrites[child_key]

            if rewrite_target is not None:
                rewrite_target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(child), str(rewrite_target))
            else:
                child.unlink()

        shutil.move(str(observation), str(target))
        for child_dir in sorted(
            (path for path in scenario_dir.rglob("*") if path.is_dir()),
            key=lambda path: len(path.parts),
            reverse=True,
        ):
            child_dir.rmdir()
        scenario_dir.rmdir()
        flattened.append(target.name)

    return flattened


def native_round_rewrites(
    repo_root: Path | None,
    round_dir: Path,
    scenario_dirs: list[Path],
    *,
    linked_raw_evidence: set[str],
) -> dict[str, str]:
    if repo_root is None or not is_native_round_dir(round_dir):
        return {}
    rewrites: dict[str, str] = {}
    for scenario_dir in scenario_dirs:
        try:
            before = (scenario_dir / "ux_observation.md").relative_to(repo_root).as_posix()
            after = (round_dir / f"{scenario_dir.name}.md").relative_to(repo_root).as_posix()
        except ValueError:
            return {}
        rewrites[before] = after
        for path in sorted(
            child
            for child in scenario_dir.rglob("*")
            if child.is_file() and child.name != "ux_observation.md"
        ):
            try:
                before = path.relative_to(repo_root).as_posix()
                if before not in linked_raw_evidence:
                    continue
                after = (
                    (
                        round_dir
                        / "linked-evidence"
                        / scenario_dir.name
                        / path.relative_to(scenario_dir)
                    )
                    .relative_to(repo_root)
                    .as_posix()
                )
            except ValueError:
                return {}
            rewrites[before] = after
    return rewrites


def validate_rewrite_targets(repo_root: Path | None, rewrites: dict[str, str]) -> None:
    if repo_root is None:
        return
    collisions = [
        repo_root / target
        for target in sorted(set(rewrites.values()))
        if (repo_root / target).exists()
    ]
    if collisions:
        lines = "\n".join(f"- {path}" for path in collisions)
        raise CleanupError(
            "Refusing to flatten because one or more rewritten native evidence targets already "
            f"exist:\n{lines}"
        )


def raw_evidence_line_parts(line: str) -> tuple[str, list[str]] | None:
    match = re.match(r"^(\s*raw_evidence:\s*)(.+?)\s*$", line)
    if match is None:
        return None
    try:
        values = json.loads(match.group(2))
    except json.JSONDecodeError:
        return None
    if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
        return None
    return match.group(1), values


def rewrite_raw_evidence_line(line: str, rewrites: dict[str, str]) -> tuple[str, bool]:
    parts = raw_evidence_line_parts(line)
    if parts is None:
        return line, False
    prefix, values = parts
    updated = [rewrites.get(item, item) for item in values]
    if updated == values:
        return line, False
    return f"{prefix}{json.dumps(updated)}", True


def split_frontmatter(text: str) -> tuple[list[str], list[str]] | None:
    if not text.startswith("---\n"):
        return None
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        return None
    for index in range(1, len(lines)):
        if lines[index] == "---":
            return lines[: index + 1], lines[index + 1 :]
    return None


def raw_evidence_scan_lines(text: str) -> list[str]:
    if not text.startswith("---\n"):
        return []
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        return []
    for index in range(1, len(lines)):
        if lines[index] == "---":
            return lines[1:index]
    return lines[1:]


def raw_evidence_values_from_text(text: str) -> list[str]:
    values: list[str] = []
    for line in raw_evidence_scan_lines(text):
        parts = raw_evidence_line_parts(line)
        if parts is None:
            continue
        _, line_values = parts
        for value in line_values:
            if value not in values:
                values.append(value)
    return values


def native_linked_raw_evidence_paths(repo_root: Path | None) -> set[str]:
    if repo_root is None:
        return set()
    linked_paths: set[str] = set()
    usability_root = repo_root / "dev" / "usability"
    for dirname in USABILITY_RECORD_DIRS:
        directory = usability_root / dirname
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            try:
                linked_paths.update(raw_evidence_values_from_text(path.read_text(encoding="utf-8")))
            except OSError as exc:
                raise CleanupError(
                    f"Cannot read native usability record before cleanup: {path}: {exc}"
                ) from exc
            except UnicodeDecodeError as exc:
                raise CleanupError(
                    f"Cannot decode native usability record as UTF-8 before cleanup: {path}: {exc}"
                ) from exc
    return linked_paths


def atomic_write_text(path: Path, text: str) -> None:
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(text)
            temp_path = Path(handle.name)
        temp_path.replace(path)
    except OSError:
        if temp_path is not None:
            with suppress(OSError):
                temp_path.unlink()
        raise


def planned_native_raw_evidence_updates(
    repo_root: Path, rewrites: dict[str, str]
) -> list[tuple[Path, str, str]]:
    planned: list[tuple[Path, str, str]] = []
    if not rewrites:
        return planned
    usability_root = repo_root / "dev" / "usability"
    for dirname in USABILITY_RECORD_DIRS:
        directory = usability_root / dirname
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            text = path.read_text(encoding="utf-8")
            sections = split_frontmatter(text)
            if sections is None:
                if not text.startswith("---\n"):
                    continue
                updated_lines = text.splitlines()
                changed = False
                for index, line in enumerate(updated_lines):
                    updated_line, line_changed = rewrite_raw_evidence_line(line, rewrites)
                    updated_lines[index] = updated_line
                    changed = changed or line_changed
                if changed:
                    newline = "\n" if text.endswith("\n") else ""
                    updated_text = "\n".join(updated_lines) + newline
                    planned.append((path, text, updated_text))
                continue
            frontmatter_lines, body_lines = sections
            changed = False
            updated_frontmatter: list[str] = []
            for line in frontmatter_lines:
                updated_line, line_changed = rewrite_raw_evidence_line(line, rewrites)
                updated_frontmatter.append(updated_line)
                changed = changed or line_changed
            if not changed:
                continue
            planned.append((path, text, "\n".join([*updated_frontmatter, *body_lines]) + "\n"))
    return planned


def refresh_native_raw_evidence_links(repo_root: Path, rewrites: dict[str, str]) -> list[Path]:
    updated_paths: list[Path] = []
    planned_updates = planned_native_raw_evidence_updates(repo_root, rewrites)
    if not planned_updates:
        return updated_paths
    written: list[tuple[Path, str]] = []
    try:
        for path, original_text, updated_text in planned_updates:
            atomic_write_text(path, updated_text)
            written.append((path, original_text))
            updated_paths.append(path)
    except OSError as exc:
        for written_path, original_text in reversed(written):
            with suppress(OSError):
                atomic_write_text(written_path, original_text)
        raise CleanupError(f"Failed to refresh native raw_evidence links: {exc}") from exc
    return updated_paths


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Archive a raw UX-testing round to a system temp zip and flatten the round "
            "into round-root markdown files."
        )
    )
    parser.add_argument(
        "round_dir",
        help=("Path to the round directory, e.g. dev/usability/evidence/rounds/01-initial"),
    )
    parser.add_argument(
        "--temp-root",
        help=(
            "Optional system temp directory to use for the archive. Defaults to /var/tmp "
            "when available, otherwise tempfile.gettempdir()."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would happen without writing the archive or modifying the round.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=(
            "Proceed even if the round looks partially flattened (numbered .md files "
            "already exist at the round root). Useful when those files are hand-written "
            "notes, not prior flattening output."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    round_dir = Path(args.round_dir).expanduser().resolve()
    repo_root = (
        inferred_repo_root_from_round_dir(round_dir)
        or find_repo_root(round_dir)
        or find_repo_root(Path.cwd().resolve())
    )

    try:
        scenario_dirs, preserved_dirs = validate_round_dir(round_dir, force=args.force)
        temp_root = choose_temp_root(
            args.temp_root,
            require_writable=not args.dry_run,
            repo_root=repo_root,
        )
    except CleanupError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    try:
        linked_raw_evidence = (
            native_linked_raw_evidence_paths(repo_root) if is_native_round_dir(round_dir) else set()
        )
        archive_path = choose_archive_path(temp_root, round_dir.name)
        rewrites = native_round_rewrites(
            repo_root,
            round_dir,
            scenario_dirs,
            linked_raw_evidence=linked_raw_evidence,
        )
    except CleanupError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(f"Round directory: {round_dir}")
    print(f"Archive path: {archive_path}")
    print(f"Scenario directories: {len(scenario_dirs)}")
    if preserved_dirs:
        print("Preserving round-level directories:")
        for path in preserved_dirs:
            print(f"- {path.name}")

    if args.dry_run:
        for scenario_dir in scenario_dirs:
            print(f"Would flatten: {scenario_dir.name} -> {scenario_dir.name}.md")
        if rewrites:
            print("Would refresh native raw_evidence links for:")
            for before, after in sorted(rewrites.items()):
                print(f"- {before} -> {after}")
        return 0

    try:
        validate_rewrite_targets(repo_root, rewrites)
    except CleanupError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    try:
        archive_round(round_dir, archive_path)
    except OSError as exc:
        if archive_path.exists():
            archive_path.unlink(missing_ok=True)
        print(f"Failed to archive raw round: {exc}", file=sys.stderr)
        return 1

    try:
        flattened = flatten_round_in_place(
            round_dir,
            scenario_dirs,
            repo_root=repo_root,
            rewrites=rewrites,
        )
    except (CleanupError, OSError, shutil.Error) as exc:
        print(f"Archived raw round to: {archive_path}", file=sys.stderr)
        print(
            "Cleanup failed after archiving. Restore the round from the zip above if you need "
            "the raw layout back before retrying.",
            file=sys.stderr,
        )
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    try:
        updated_records = (
            refresh_native_raw_evidence_links(repo_root, rewrites) if repo_root else []
        )
    except (CleanupError, OSError, UnicodeDecodeError) as exc:
        print(f"Archived raw round to: {archive_path}", file=sys.stderr)
        print(
            "Cleanup failed after archiving. Restore the round from the zip above if you need "
            "the raw layout back before retrying.",
            file=sys.stderr,
        )
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Archived raw round to: {archive_path}")
    if flattened:
        print("Flattened files:")
        for name in flattened:
            print(f"- {name}")
    if updated_records:
        print("Refreshed native raw_evidence links in:")
        for path in updated_records:
            print(f"- {path.relative_to(repo_root).as_posix()}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
