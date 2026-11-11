#!/usr/bin/env python3
"""Build an ad-hoc signed use-my-llm app for Apple Silicon Macs."""

import argparse
import hashlib
import json
import platform
import plistlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path


PACKAGE = Path(__file__).resolve().parent
REPO = PACKAGE.parents[1]
BRIDGE = PACKAGE.parent / "bridge"
APP_NAME = "use-my-llm"
APP_EXECUTABLE = "use-my-llm"
APP_ID = "dev.localhostagent.sdk"
MINIMUM_MACOS = "13.5"
NODE_VERSION = "v24.22.2"
NODE_DIRECTORY = f"node-{NODE_VERSION}-darwin-arm64"
NODE_ARCHIVE = f"{NODE_DIRECTORY}.tar.gz"
NODE_URL = f"https://nodejs.org/dist/{NODE_VERSION}/{NODE_ARCHIVE}"
# Node.js release SHASUMS: https://nodejs.org/en/blog/release/v24.22.2
NODE_SHA256 = "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a"
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_node(destination: Path) -> None:
    with urllib.request.urlopen(NODE_URL, timeout=30) as response, destination.open("xb") as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_ARCHIVE_BYTES:
                raise ValueError("The Node.js archive exceeds the download size limit.")
            output.write(chunk)


def include_node(archive_path: Path, resources: Path) -> None:
    if sha256(archive_path) != NODE_SHA256:
        raise ValueError(f"The Node.js archive does not match the published SHA-256 for {NODE_ARCHIVE}.")

    # Read only the two required regular files. Archive paths are never extracted.
    with tarfile.open(archive_path, "r:gz") as archive:
        for member_name, filename in (("bin/node", "node"), ("LICENSE", "NODE-LICENSE.txt")):
            member = archive.getmember(f"{NODE_DIRECTORY}/{member_name}")
            if not member.isfile():
                raise ValueError(f"The Node.js archive member {member_name} is not a regular file.")
            with archive.extractfile(member) as source, (resources / filename).open("xb") as destination:
                shutil.copyfileobj(source, destination)
    (resources / "node").chmod(0o755)


def include_bridge(resources: Path) -> None:
    manifest_path = BRIDGE / "package.json"
    dist = BRIDGE / "dist"
    license_path = REPO / "LICENSE"
    if any(path.is_symlink() for path in (BRIDGE, manifest_path, dist, license_path)):
        raise ValueError("Bridge runtime and licenses must not be symbolic links.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("dependencies") or manifest.get("optionalDependencies"):
        raise ValueError("The desktop build requires a dependency-free bridge runtime.")
    if not dist.is_dir():
        raise ValueError("Bridge dist is missing. Build the bridge before packaging the app.")

    # Copy only the known runtime files, never source, maps, declarations, or local data.
    runtime_files = (
        "cli.mjs", "server.mjs", "claude-auth.mjs", "providers/index.mjs", "providers/codex.mjs",
        "providers/claude.mjs", "providers/claude-api.mjs", "providers/antigravity.mjs",
        "providers/google-sdk.mjs", "providers/google_sdk.py", "providers/prompt.mjs",
        "context/cli.mjs", "context/fork.mjs", "context/redact.mjs", "context/service.mjs",
        "context/store.mjs", "context/types.mjs", "context/zip.mjs",
        "context/sources/antigravity.mjs", "context/sources/claude-code.mjs",
        "context/sources/claude-desktop.mjs", "context/sources/codex.mjs",
        "context/sources/index.mjs", "context/sources/util.mjs",
    )
    for path in dist.rglob("*"):
        if path.is_symlink():
            raise ValueError("Bridge dist must not contain symbolic links.")
    destination = resources / "app" / "packages" / "bridge" / "dist"
    for name in runtime_files:
        source = dist / name
        if not source.is_file():
            raise ValueError(f"Required bridge runtime file is missing: dist/{name}. Build the bridge first.")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    shutil.copy2(license_path, resources / "LICENSE.txt")


def build_app(app: Path, archive_path: Path, version: str, build_number: str) -> None:
    contents = app / "Contents"
    resources = contents / "Resources"
    macos = contents / "MacOS"
    resources.mkdir(parents=True)
    macos.mkdir()

    include_bridge(resources)
    include_node(archive_path, resources)
    with (contents / "Info.plist").open("wb") as stream:
        plistlib.dump(
            {
                "CFBundleName": APP_NAME,
                "CFBundleDisplayName": APP_NAME,
                "CFBundleIdentifier": APP_ID,
                "CFBundleExecutable": APP_EXECUTABLE,
                "CFBundlePackageType": "APPL",
                "CFBundleVersion": build_number,
                "CFBundleShortVersionString": version,
                "CFBundleURLTypes": [
                    {
                        "CFBundleTypeRole": "Viewer",
                        "CFBundleURLName": APP_ID,
                        "CFBundleURLSchemes": ["localhostagent"],
                    }
                ],
                "LSMinimumSystemVersion": MINIMUM_MACOS,
                "LSUIElement": True,
            },
            stream,
        )

    subprocess.run(
        [
            "/usr/bin/xcrun", "swiftc", "-O", "-target", f"arm64-apple-macosx{MINIMUM_MACOS}",
            str(PACKAGE / "src" / "Launcher.swift"), str(PACKAGE / "src" / "ContextPicker.swift"),
            "-o", str(macos / APP_EXECUTABLE),
            "-framework", "AppKit",
        ],
        check=True,
    )
    for target in (resources / "node", app):
        subprocess.run(
            ["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(target)],
            check=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "dist" / "desktop-macos",
                        help="A new directory for the app and ZIP")
    parser.add_argument("--node-archive", type=Path, help=f"Optional local copy of {NODE_ARCHIVE}")
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--build-number", default="1")
    args = parser.parse_args()

    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("Build on an Apple Silicon Mac with native arm64 Python.")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
        parser.error("--version must contain three numeric components.")
    if not re.fullmatch(r"[1-9][0-9]*", args.build_number):
        parser.error("--build-number must be a positive integer.")

    output = args.output.resolve()
    if output.exists():
        parser.error(f"Choose a new --output directory. {output} already exists.")
    output.parent.mkdir(parents=True, exist_ok=True)

    try:
        with tempfile.TemporaryDirectory(prefix=".use-my-llm-build-", dir=output.parent) as directory:
            work = Path(directory)
            if args.node_archive:
                archive_path = args.node_archive.resolve()
            else:
                archive_path = work / NODE_ARCHIVE
                download_node(archive_path)

            release = work / "release"
            app = release / f"{APP_NAME}.app"
            zip_path = release / "use-my-llm-macos-arm64.zip"
            build_app(app, archive_path, args.version, args.build_number)
            subprocess.run(
                ["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(zip_path)],
                check=True,
            )
            if output.exists():
                raise ValueError(f"The output directory {output} was created during the build.")
            release.rename(output)
    except (OSError, KeyError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Desktop build failed: {error}") from None

    print(f"App: {output / app.name}")
    print(f"ZIP: {output / zip_path.name}")
    print("Ad-hoc signed for local testing. Developer ID signing and notarization are separate release steps.")


if __name__ == "__main__":
    main()
