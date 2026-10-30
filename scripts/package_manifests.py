"""Write the Homebrew cask and Scoop manifest for a release, from its uploaded files.

Usage: python scripts/package_manifests.py <tag>   (needs the `gh` CLI, authenticated)

This repository doubles as a Homebrew tap (Casks/) and a Scoop bucket (bucket/):

    brew tap kingvic300/prismagram https://github.com/Kingvic300/Prismagram && brew install --cask prismagram
    scoop bucket add prismagram https://github.com/Kingvic300/Prismagram && scoop install prismagram

A manifest is only rewritten when every file it needs is in the release, so a failed
platform build leaves the previous version in place.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = "Kingvic300/Prismagram"
ROOT = Path(__file__).resolve().parents[1]
DESC = "Prisma schema diagrams and a database client"
HOMEPAGE = "https://kingvic300.github.io/Prismagram/"


def digests(tag: str) -> dict[str, str]:
    out = subprocess.run(["gh", "api", f"repos/{REPO}/releases/tags/{tag}"], check=True, capture_output=True, text=True).stdout
    return {a["name"]: (a.get("digest") or "").removeprefix("sha256:") for a in json.loads(out)["assets"] if a.get("digest")}


def cask(version: str, arm: str, intel: str) -> str:
    return f'''cask "prismagram" do
  arch arm: "aarch64", intel: "x64"

  version "{version}"
  sha256 arm:   "{arm}",
         intel: "{intel}"

  url "https://github.com/{REPO}/releases/download/v#{{version}}/Prismagram_#{{version}}_#{{arch}}.dmg"
  name "Prismagram"
  desc "{DESC}"
  homepage "{HOMEPAGE}"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :catalina"

  app "Prismagram.app"

  zap trash: "~/Library/Application Support/io.github.kingvic300.prismagram"

  caveats <<~EOS
    Prismagram is not code-signed yet. If macOS says it cannot be opened, run:
      xattr -dr com.apple.quarantine "#{{appdir}}/Prismagram.app"
  EOS
end
'''


def scoop(version: str, exe_hash: str) -> str:
    url = f"https://github.com/{REPO}/releases/download/v{{v}}/Prismagram_{{v}}_x64-setup.exe#/dl.7z"
    return json.dumps(
        {
            "version": version,
            "description": DESC,
            "homepage": HOMEPAGE,
            "license": "MIT",
            "architecture": {"64bit": {"url": url.format(v=version), "hash": exe_hash}},
            # The NSIS installer is unpacked rather than run; drop its installer-only parts.
            "pre_install": 'Remove-Item "$dir\\$PLUGINSDIR", "$dir\\uninstall.exe" -Recurse -Force -ErrorAction SilentlyContinue',
            "shortcuts": [["prismagram.exe", "Prismagram"]],
            "checkver": "github",
            "autoupdate": {"architecture": {"64bit": {"url": url.format(v="$version")}}},
        },
        indent=4,
    ) + "\n"


def main(tag: str) -> None:
    version = tag.lstrip("v")
    d = digests(tag)
    arm, intel = d.get(f"Prismagram_{version}_aarch64.dmg"), d.get(f"Prismagram_{version}_x64.dmg")
    if arm and intel:
        (ROOT / "Casks").mkdir(exist_ok=True)
        (ROOT / "Casks" / "prismagram.rb").write_text(cask(version, arm, intel))
        print(f"Casks/prismagram.rb -> {version}")
    else:
        print("Homebrew cask unchanged: a macOS .dmg is missing from the release", file=sys.stderr)
    exe = d.get(f"Prismagram_{version}_x64-setup.exe")
    if exe:
        (ROOT / "bucket").mkdir(exist_ok=True)
        (ROOT / "bucket" / "prismagram.json").write_text(scoop(version, exe))
        print(f"bucket/prismagram.json -> {version}")
    else:
        print("Scoop manifest unchanged: the Windows installer is missing from the release", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
