#!/usr/bin/env bash
# Build Prismagram's signed APT and RPM repositories from the latest GitHub release, for GitHub Pages.
#
#   APT_SIGNING_KEY="$(cat private-key.asc)" scripts/build_linux_repos.sh site [release-files-dir]
#
# Writes <site>/apt (Debian, Ubuntu, Kali), <site>/rpm (Fedora, RHEL, openSUSE), <site>/prismagram.repo
# and the public key <site>/prismagram.gpg / prismagram.asc. Without a files directory it downloads the
# latest release's .deb and .rpm (needs the `gh` CLI). Users run site/install.sh once; after that
# their package manager installs and updates Prismagram like any other package.
set -euo pipefail

SITE="${1:?usage: build_linux_repos.sh <site dir> [release files dir]}"
FILES="${2:-}"
REPO="Kingvic300/Prismagram"
BASE="https://kingvic300.github.io/Prismagram"

if [[ -z "${APT_SIGNING_KEY:-}" ]]; then
  echo "APT_SIGNING_KEY is not set; skipping the Linux package repositories." >&2
  exit 0
fi
SITE="$(cd "$SITE" && pwd)"

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
WORK="$(mktemp -d)"
trap 'rm -rf "$GNUPGHOME" "$WORK"' EXIT
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import
gpg --batch --yes --export -o "$SITE/prismagram.gpg"       # binary keyring for apt's signed-by
gpg --batch --yes --armor --export -o "$SITE/prismagram.asc"

if [[ -z "$FILES" ]]; then
  FILES="$WORK/release"
  tag="$(gh release view -R "$REPO" --json tagName --jq .tagName)"
  gh release download "$tag" -R "$REPO" -p '*_amd64.deb' -p '*.x86_64.rpm' -D "$FILES"
fi

# --- APT ---------------------------------------------------------------------
APT="$SITE/apt"
rm -rf "$APT"
mkdir -p "$APT/pool/main" "$APT/dists/stable/main/binary-amd64"
cp "$FILES"/*_amd64.deb "$APT/pool/main/"
(
  cd "$APT"
  apt-ftparchive packages pool > dists/stable/main/binary-amd64/Packages
  gzip -9kf dists/stable/main/binary-amd64/Packages
  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin=Prismagram \
    -o APT::FTPArchive::Release::Label=Prismagram \
    -o APT::FTPArchive::Release::Suite=stable \
    -o APT::FTPArchive::Release::Codename=stable \
    -o APT::FTPArchive::Release::Architectures=amd64 \
    -o APT::FTPArchive::Release::Components=main \
    -o "APT::FTPArchive::Release::Description=Prismagram, Prisma schema diagrams and a database client" \
    release dists/stable > dists/stable/Release
  gpg --batch --yes --clearsign -o dists/stable/InRelease dists/stable/Release
  gpg --batch --yes --armor --detach-sign -o dists/stable/Release.gpg dists/stable/Release
)

# --- RPM ---------------------------------------------------------------------
RPM="$SITE/rpm"
rm -rf "$RPM"
mkdir -p "$RPM"
cp "$FILES"/*.x86_64.rpm "$RPM/"
createrepo_c --quiet "$RPM"
gpg --batch --yes --armor --detach-sign -o "$RPM/repodata/repomd.xml.asc" "$RPM/repodata/repomd.xml"
cat > "$SITE/prismagram.repo" <<EOF
[prismagram]
name=Prismagram
baseurl=$BASE/rpm
enabled=1
type=rpm-md
gpgcheck=0
repo_gpgcheck=1
gpgkey=$BASE/prismagram.asc
EOF

echo "Linux repositories built in $SITE:" >&2
grep -E '^(Package|Version|Filename):' "$APT/dists/stable/main/binary-amd64/Packages" >&2
ls "$RPM"/*.rpm >&2
