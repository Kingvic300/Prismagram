#!/bin/sh
# Install Prismagram on Linux with one command:
#
#   curl -fsSL https://kingvic300.github.io/Prismagram/install.sh | sudo sh
#
# Debian, Ubuntu, Kali (apt) and Fedora, RHEL, openSUSE (dnf, yum, zypper): adds Prismagram's signed
# package repository once, then installs Prismagram. After that your package manager installs and
# updates it like any other package (sudo apt upgrade, sudo dnf upgrade, sudo zypper update).
# Any other distribution: installs the AppImage to /opt/prismagram, which updates itself.
set -eu

BASE="https://kingvic300.github.io/Prismagram"
KEYRING="/usr/share/keyrings/prismagram.gpg"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo: curl -fsSL $BASE/install.sh | sudo sh" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) echo "Prismagram's Linux builds are for 64-bit Intel/AMD (x86_64) only." >&2; exit 1 ;;
esac

if command -v apt-get >/dev/null 2>&1; then
  echo "Adding Prismagram's APT repository..."
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL "$BASE/prismagram.gpg" -o "$KEYRING.tmp" && mv "$KEYRING.tmp" "$KEYRING" && chmod 0644 "$KEYRING"
  echo "deb [arch=amd64 signed-by=$KEYRING] $BASE/apt stable main" > /etc/apt/sources.list.d/prismagram.list
  apt-get update
  apt-get install -y prismagram
  echo "Done. Updates arrive with: sudo apt upgrade"
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  echo "Adding Prismagram's RPM repository..."
  curl -fsSL "$BASE/prismagram.repo" -o /etc/yum.repos.d/prismagram.repo
  if command -v dnf >/dev/null 2>&1; then dnf install -y prismagram; else yum install -y prismagram; fi
  echo "Done. Updates arrive with: sudo dnf upgrade"
elif command -v zypper >/dev/null 2>&1; then
  echo "Adding Prismagram's RPM repository..."
  zypper --non-interactive --gpg-auto-import-keys addrepo --refresh "$BASE/prismagram.repo"
  zypper --non-interactive --gpg-auto-import-keys install prismagram
  echo "Done. Updates arrive with: sudo zypper update"
else
  echo "No apt, dnf, yum or zypper found; installing the AppImage..."
  url="$(curl -fsSL https://api.github.com/repos/Kingvic300/Prismagram/releases/latest | grep -o 'https://[^"]*_amd64\.AppImage' | head -n 1)"
  [ -n "$url" ] || { echo "Could not find the latest AppImage." >&2; exit 1; }
  install -d -m 0755 /opt/prismagram
  curl -fL "$url" -o /opt/prismagram/Prismagram.AppImage
  chmod 0755 /opt/prismagram/Prismagram.AppImage
  chown -R "${SUDO_USER:-root}" /opt/prismagram  # lets the AppImage update itself without sudo
  ln -sf /opt/prismagram/Prismagram.AppImage /usr/local/bin/prismagram
  cat > /usr/share/applications/prismagram.desktop <<EOF
[Desktop Entry]
Name=Prismagram
Comment=Prisma schema diagrams and a database client
Exec=/opt/prismagram/Prismagram.AppImage
Terminal=false
Type=Application
Categories=Development;
EOF
  echo "Done. Run 'prismagram' or open Prismagram from your applications menu. It updates itself."
fi
