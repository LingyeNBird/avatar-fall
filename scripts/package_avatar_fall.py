from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import TypedDict, cast
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
PLUGIN_DIR = ROOT / "plugins-demo" / "avatar-fall"
RELEASE_DIR = ROOT / "release"


class Manifest(TypedDict):
    id: str
    version: str
    main: str
    icon: str
    include: list[str]


def run_command(command: list[str], cwd: Path) -> None:
    _ = subprocess.run(command, cwd=str(cwd), check=True)


def load_manifest() -> Manifest:
    manifest_path = PLUGIN_DIR / "manifest.json"
    with manifest_path.open("r", encoding="utf-8") as f:
        raw = cast(dict[str, object], json.load(f))

    plugin_id = cast(str, raw["id"])
    version = cast(str, raw["version"])
    main = cast(str, raw["main"])
    icon = cast(str, raw.get("icon", ""))
    include = cast(list[str], raw.get("include", []))
    return Manifest(
        id=plugin_id, version=version, main=main, icon=icon, include=include
    )


def resolve_release_files(manifest: Manifest) -> list[Path]:
    required = [Path("manifest.json"), Path(manifest["main"])]
    icon = manifest["icon"]
    if icon:
        required.append(Path(icon))

    includes = manifest["include"]
    for item in includes:
        required.append(Path(item))

    unique: list[Path] = []
    seen: set[str] = set()
    for rel in required:
        key = rel.as_posix()
        if key in seen:
            continue
        seen.add(key)
        unique.append(rel)
    return unique


def collect_files(paths: list[Path]) -> list[Path]:
    files: list[Path] = []
    for rel in paths:
        full = PLUGIN_DIR / rel
        if not full.exists():
            raise FileNotFoundError(f"Missing required file: {rel.as_posix()}")
        if full.is_file():
            files.append(full)
            continue
        for child in sorted(full.rglob("*")):
            if child.is_file():
                files.append(child)
    return files


def build_zip(files: list[Path], plugin_id: str, version: str) -> Path:
    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = RELEASE_DIR / f"{plugin_id}-{version}.zip"
    with ZipFile(zip_path, "w", compression=ZIP_DEFLATED) as zf:
        for file_path in files:
            rel = file_path.relative_to(PLUGIN_DIR)
            arcname = Path(plugin_id) / rel
            zf.write(file_path, arcname.as_posix())
    return zip_path


def main() -> None:
    run_command(["npm", "install"], PLUGIN_DIR)
    run_command(["npm", "run", "build"], PLUGIN_DIR)

    manifest = load_manifest()
    plugin_id = manifest["id"]
    version = manifest["version"]
    release_entries = resolve_release_files(manifest)
    files = collect_files(release_entries)
    zip_path = build_zip(files, plugin_id, version)

    print(f"Created: {zip_path}")
    print("Included files:")
    for file_path in files:
        print(f"- {file_path.relative_to(PLUGIN_DIR).as_posix()}")


if __name__ == "__main__":
    main()
