#!/bin/sh
# Installs the latest stable Novadeck on x86_64 Linux:
#
#   curl -fsSL https://github.com/@REPOSITORY@/releases/latest/download/install.sh | sh
#
# It installs the .deb with apt, the .rpm with dnf or zypper, and otherwise puts the
# AppImage in ~/.local/share/novadeck with a menu entry and a `novadeck` command. Every
# download is checked against the release's SHA256SUMS first. Running it again upgrades or
# repairs the install; installed apps update themselves after that.
#
# The release workflow replaces @REPOSITORY@ with the repository it publishes from. On
# image-based systems, where a package would need a reboot or a layered image, it installs
# the AppImage whatever package manager is there. These environment variables change it:
#
#   NOVADECK_INSTALL_BASE_URL         The folder to download from, for a mirror or a test.
#   NOVADECK_INSTALL_PACKAGE_MANAGER  apt, dnf, zypper or appimage, to skip detection.
#   XDG_DATA_HOME                     Where the AppImage install puts its files, as usual;
#                                     the default is ~/.local/share.
#
# Test hooks, not for use otherwise:
#
#   NOVADECK_INSTALL_OSTREE_MARKER    The file whose presence means an ostree system, in
#                                     place of /run/ostree-booted.
#   NOVADECK_INSTALL_SBIN_DIRS        The folders searched, after the PATH, for ldconfig and
#                                     transactional-update, in place of "/sbin /usr/sbin".
#
# Every definition comes before the one call on the last line, so a download that is cut
# short runs nothing.

fail() {
  printf 'novadeck install: %s\n' "$1" >&2
  exit 1
}

say() {
  printf '%s\n' "$1"
}

has() {
  command -v "$1" > /dev/null 2>&1
}

# Linux on x86_64 only; macOS and Windows have their own installers.
check_platform() {
  repository="$1"
  case "$(uname -s)" in
    Linux) ;;
    Darwin)
      fail "this installer is for Linux. On macOS, download https://github.com/$repository/releases/latest/download/novadeck-mac-universal.dmg and drag the app to Applications."
      ;;
    *)
      fail "this installer is for Linux. On Windows, download https://github.com/$repository/releases/latest/download/novadeck-win-x64-setup.exe."
      ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) ;;
    *) fail "Novadeck is built for x86_64 only, and this computer is $(uname -m)." ;;
  esac
}

# The path of a tool on the PATH or in the system folders a user's PATH often lacks, or
# nothing when it is nowhere.
find_tool() {
  if has "$1"; then
    command -v "$1"
    return 0
  fi
  # shellcheck disable=SC2086
  for dir in ${NOVADECK_INSTALL_SBIN_DIRS:-/sbin /usr/sbin}; do
    if [ -x "$dir/$1" ]; then
      printf '%s\n' "$dir/$1"
      return 0
    fi
  done
}

# Fedora Silverblue, Kinoite and Bazzite (ostree), and openSUSE Aeon and MicroOS
# (transactional-update), keep the system read-only; a home folder install suits them.
is_immutable() {
  [ -e "${NOVADECK_INSTALL_OSTREE_MARKER:-/run/ostree-booted}" ] || [ -n "$(find_tool transactional-update)" ]
}

# Which way to install: the first package manager found, or the AppImage.
detect_method() {
  if [ -n "${NOVADECK_INSTALL_PACKAGE_MANAGER:-}" ]; then
    printf '%s\n' "$NOVADECK_INSTALL_PACKAGE_MANAGER"
  elif is_immutable; then
    say appimage
  elif has apt-get; then
    say apt
  elif has dnf; then
    say dnf
  elif has zypper; then
    say zypper
  else
    say appimage
  fi
}

download() {
  curl -fsSL --retry 3 --retry-connrefused -o "$2" "$1" || fail "could not download $1"
}

# Succeeds only when the file's SHA-256 is the one SHA256SUMS lists for its name.
verify() {
  name="$1"
  expected="$(awk -v name="$name" '$2 == name || $2 == "*" name { print $1; exit }' SHA256SUMS)"
  [ -n "$expected" ] || fail "SHA256SUMS lists no $name."
  actual="$(sha256sum "$name" | awk '{ print $1 }')"
  [ "$expected" = "$actual" ] || fail "$name does not match its checksum in SHA256SUMS; try again, and report it if it persists."
}

fetch() {
  base="$1"
  name="$2"
  say "Downloading $name"
  download "$base/$name" "$name"
  verify "$name"
}

# Runs a command as root, through sudo unless this already is root.
as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif has sudo; then
    sudo "$@"
  else
    fail "installing a package needs root, and sudo is not installed. Run this as root."
  fi
}

# The version of the installed novadeck package, or nothing when none is installed.
installed_deb_version() {
  has dpkg-query || return 0
  # shellcheck disable=SC2016
  status="$(dpkg-query -W -f='${db:Status-Status} ${Version}' novadeck 2> /dev/null || true)"
  case "$status" in
    "installed "*) printf '%s\n' "${status#installed }" ;;
  esac
}

install_apt() {
  fetch "$1" novadeck-linux-amd64.deb
  installed="$(installed_deb_version)"
  if [ -n "$installed" ] && has dpkg; then
    available="$(dpkg-deb -f novadeck-linux-amd64.deb Version)"
    # Apt refuses a downgrade, and an early channel build is newer than the stable one.
    if dpkg --compare-versions "$installed" gt "$available"; then
      say "Novadeck $installed is already installed, and it is newer than the stable release, $available. Nothing to do."
      return 0
    fi
  fi
  as_root apt-get install -y ./novadeck-linux-amd64.deb
}

install_dnf() {
  fetch "$1" novadeck-linux-x86_64.rpm
  as_root dnf install -y ./novadeck-linux-x86_64.rpm
}

install_zypper() {
  fetch "$1" novadeck-linux-x86_64.rpm
  as_root zypper --non-interactive install --allow-unsigned-rpm ./novadeck-linux-x86_64.rpm
}

# An AppImage mounts itself through libfuse 2, which newer distributions no longer include.
check_fuse() {
  # Without ldconfig there is nothing to check, and no warning is better than a wrong one.
  ldconfig="$(find_tool ldconfig)"
  [ -n "$ldconfig" ] || return 0
  if "$ldconfig" -p 2> /dev/null | grep -q 'libfuse\.so\.2'; then
    return 0
  fi
  say "Novadeck's AppImage needs FUSE 2, which this computer seems to lack."
  say "Install your distribution's libfuse2 package (libfuse2t64 on Ubuntu 24.04 and later,"
  say "fuse-libs on Fedora), or start Novadeck with --appimage-extract-and-run."
}

install_appimage() {
  base="$1"
  data="${XDG_DATA_HOME:-$HOME/.local/share}"
  bin="$HOME/.local/bin"
  folder="$data/novadeck"
  image="$folder/novadeck.AppImage"

  fetch "$base" novadeck-linux-x86_64.AppImage
  chmod +x novadeck-linux-x86_64.AppImage

  # The icon comes out of the AppImage without mounting it, so this needs no FUSE.
  icon=""
  if ./novadeck-linux-x86_64.AppImage --appimage-extract usr/share/icons/hicolor/512x512/apps/novadeck.png > /dev/null 2>&1 &&
    [ -f squashfs-root/usr/share/icons/hicolor/512x512/apps/novadeck.png ]; then
    icon="$data/icons/hicolor/512x512/apps/novadeck.png"
    mkdir -p "$data/icons/hicolor/512x512/apps"
    cp squashfs-root/usr/share/icons/hicolor/512x512/apps/novadeck.png "$icon"
  else
    say "Could not extract the icon; the menu entry will have none."
  fi

  # A new file renamed over the old one, so an upgrade works while Novadeck is running.
  mkdir -p "$folder" "$data/applications" "$bin"
  cp novadeck-linux-x86_64.AppImage "$image.new"
  chmod +x "$image.new"
  mv -f "$image.new" "$image"
  ln -sf "$image" "$bin/novadeck"

  cat > "$data/applications/dev.mzpk.novadeck.desktop" << EOF
[Desktop Entry]
Type=Application
Name=novadeck.
Comment=A workspace for parallel terminals.
Exec="$image" %U
Icon=${icon:-novadeck}
Terminal=false
Categories=Utility;
StartupWMClass=dev.mzpk.novadeck
EOF

  say "Installed Novadeck to $image"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) say "Add $bin to your PATH to start it as \`novadeck\`: export PATH=\"$bin:\$PATH\"" ;;
  esac
  check_fuse
}

main() {
  set -eu
  repository='@REPOSITORY@'
  base="${NOVADECK_INSTALL_BASE_URL:-https://github.com/$repository/releases/latest/download}"
  base="${base%/}"

  check_platform "$repository"
  has curl || fail "curl is required."
  has sha256sum || fail "sha256sum is required."

  method="$(detect_method)"
  case "$method" in
    apt | dnf | zypper | appimage) ;;
    *) fail "unknown package manager: $method" ;;
  esac

  work="$(mktemp -d)" || fail "could not create a temporary folder."
  # Readable by apt's unprivileged downloader, which would otherwise warn about the folder.
  chmod 755 "$work"
  trap 'rm -rf "$work"' EXIT
  cd "$work" || fail "could not enter $work."

  say "Installing Novadeck with $method"
  download "$base/SHA256SUMS" SHA256SUMS
  case "$method" in
    apt) install_apt "$base" ;;
    dnf) install_dnf "$base" ;;
    zypper) install_zypper "$base" ;;
    appimage) install_appimage "$base" ;;
  esac
  say "Done. Novadeck updates itself from here."
}

main "$@"
