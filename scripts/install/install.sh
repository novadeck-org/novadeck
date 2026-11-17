#!/bin/sh
# Installs the latest stable Novadeck on x86_64 Linux and on macOS:
#
#   curl -fsSL https://github.com/@REPOSITORY@/releases/latest/download/install.sh | sh
#
# On Linux it puts the AppImage in ~/.local/share/novadeck with a menu entry and a
# `novadeck` command. On macOS it puts the app in /Applications, or in ~/Applications when
# this account cannot write to /Applications, and replaces a copy already in either.
# Every download is checked against the release's SHA256SUMS first, and against its build
# attestation too when the GitHub CLI (gh) is installed and signed in. Running it again
# upgrades or repairs the install; installed apps update themselves after that, except an
# unsigned macOS build, which only tells of new versions.
#
# Ubuntu 24.04 and later stop unprivileged programs from creating the user namespaces
# Electron's sandbox needs, and the AppImage then runs without a sandbox. On such a system
# the install writes an AppArmor profile to /etc/apparmor.d/novadeck-appimage-<uid> with
# sudo, which asks for a password once. If that fails, the install still finishes and says how to retry:
#
#   curl -fsSL https://github.com/@REPOSITORY@/releases/latest/download/install.sh | sh -s -- --sandbox
#
# --sandbox does only that step, for an existing install, such as one Homebrew made. macOS
# needs no such step.
#
# --uninstall removes what the install put on this computer, and downloads nothing:
#
#   curl -fsSL https://github.com/@REPOSITORY@/releases/latest/download/install.sh | sh -s -- --uninstall
#
# On Linux that is the AppImage, the `novadeck` command if it points at that AppImage, the
# menu entry, the icon, and the AppArmor profile, which asks for sudo once; if that fails,
# it still finishes and says how to retry. The novadeck folder goes too, but only when
# nothing else is in it. On macOS it moves the app to the Trash, and refuses while the app
# runs. An install Homebrew made is Homebrew's to remove, and the script says how. Nothing
# you made is removed: not Novadeck's data, nor the plugins connected to your agents. The
# script says where the data is and how to remove the plugins.
#
# It speaks in a banner, phases and a sign-off, in colour on a terminal unless NO_COLOR is set,
# with the banner's tagline typed out and curl's progress bar shown there. A piped run prints
# the same lines without colour or animation, and errors go to stderr.
#
# The release workflow replaces @REPOSITORY@ with the repository it publishes from, and
# @VERSION@ with the version it releases; an unrendered copy names no version. These
# environment variables change it:
#
#   NOVADECK_INSTALL_BASE_URL         The folder to download from, for a mirror or a test.
#   XDG_DATA_HOME                     Where the install puts its files, as usual; the default
#                                     is ~/.local/share, and a path that is not absolute
#                                     counts as unset. The profile covers that path too.
#
# Test hooks, not for use otherwise:
#
#   NOVADECK_INSTALL_SBIN_DIRS        The folders searched, before the PATH, for
#                                     apparmor_parser, in place of "/sbin /usr/sbin".
#   NOVADECK_INSTALL_USERNS_SYSCTL    The file that says whether unprivileged user
#                                     namespaces are restricted, in place of
#                                     /proc/sys/kernel/apparmor_restrict_unprivileged_userns.
#   NOVADECK_INSTALL_APPARMOR_DIR     The folder the profile goes to, in place of
#                                     /etc/apparmor.d.
#   NOVADECK_INSTALL_PROFILES         The folder with one folder per loaded AppArmor
#                                     profile, each holding a `name` file, in place of
#                                     /sys/kernel/security/apparmor/policy/profiles.
#   NOVADECK_INSTALL_FUSE_DEVICE      The device AppImages mount through, in place of
#                                     /dev/fuse.
#   NOVADECK_INSTALL_APPLICATIONS_DIR The system-wide Applications folder on macOS, in
#                                     place of /Applications.
#   NOVADECK_INSTALL_CASKROOMS        The folders Homebrew keeps casks in, searched for
#                                     novadeck by --uninstall, in place of
#                                     "/opt/homebrew/Caskroom /usr/local/Caskroom
#                                     /home/linuxbrew/.linuxbrew/Caskroom".
#
# Every definition comes before the one call on the last line, so a download that is cut
# short runs nothing.

# Colour codes for stdout, and for stderr, each only on a terminal and never with NO_COLOR.
# Unset until style runs, so a function called on its own prints plain text.
style() {
  TEAL='' RED='' YELLOW='' DIM='' BOLD='' WHITE='' RESET='' ANIMATE=false
  ERR_RED='' ERR_BOLD='' ERR_DIM='' ERR_RESET=''
  [ -z "${NO_COLOR:-}" ] || return 0
  if [ -t 1 ]; then
    case "${COLORTERM:-}" in
      truecolor | 24bit) TEAL="$(printf '\033[38;2;0;229;214m')" ;;
      *) TEAL="$(printf '\033[96m')" ;;
    esac
    RED="$(printf '\033[91m')"
    YELLOW="$(printf '\033[93m')"
    DIM="$(printf '\033[2m')"
    BOLD="$(printf '\033[1m')"
    WHITE="$(printf '\033[97m')"
    RESET="$(printf '\033[0m')"
    ANIMATE=true
  fi
  if [ -t 2 ]; then
    ERR_RED="$(printf '\033[91m')"
    ERR_BOLD="$(printf '\033[1m')"
    ERR_DIM="$(printf '\033[2m')"
    ERR_RESET="$(printf '\033[0m')"
  fi
}

fail() {
  printf '\n    %s%s✗ flatlined%s %s— %s%s\n\n' "${ERR_RED:-}" "${ERR_BOLD:-}" "${ERR_RESET:-}" "${ERR_DIM:-}" "${ERR_RESET:-}" "$1" >&2
  exit 1
}

# A line of its own, under the phase it belongs to.
say() {
  printf '        %s›%s %s\n' "${DIM:-}" "${RESET:-}" "$1"
}

# The heading of a phase: `>>> name`.
section() {
  printf '\n    %s>>>%s %s%s%s\n' "${DIM:-}" "${RESET:-}" "${BOLD:-}" "$1" "${RESET:-}"
}

# Marks at the start of a line: done, worth knowing, failed, removed.
ok() { say "${TEAL:-}✓${RESET:-} $1"; }
warn() { say "${YELLOW:-}!${RESET:-} $1"; }
bad() { say "${RED:-}✗${RESET:-} $1"; }
gone() { say "${DIM:-}−${RESET:-} $1"; }

# Words that matter less, dimmed.
quiet() {
  printf '%s%s%s' "${DIM:-}" "$1" "${RESET:-}"
}

# A path as the person reads it, with their home folder as ~.
tidy() {
  # shellcheck disable=SC2088 # A ~ to read, not to expand.
  case "${HOME:+$1}" in
    "$HOME"/*) printf '~/%s\n' "${1#"$HOME"/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# Typed out a character at a time on a terminal, printed whole otherwise. A sleep that
# takes no fraction just makes it print at once.
typing() {
  printf '    '
  if [ "$ANIMATE" = true ]; then
    rest="$1"
    while [ -n "$rest" ]; do
      next="${rest#?}"
      printf '%s' "${rest%"$next"}"
      rest="$next"
      sleep 0.03 2> /dev/null || true
    done
  else
    printf '%s' "$1"
  fi
  printf '\n'
}

# NOVADECK in the ANSI Shadow figlet font, with the tagline and the release under it, then
# a line typed out.
banner() {
  printf '%s%s\n' "$TEAL" "$BOLD"
  cat << 'EOF'
    ███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ ██████╗ ███████╗ ██████╗██╗  ██╗
    ████╗  ██║██╔═══██╗██║   ██║██╔══██╗██╔══██╗██╔════╝██╔════╝██║ ██╔╝
    ██╔██╗ ██║██║   ██║██║   ██║███████║██║  ██║█████╗  ██║     █████╔╝
    ██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║██║  ██║██╔══╝  ██║     ██╔═██╗
    ██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║██████╔╝███████╗╚██████╗██║  ██╗
    ╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝╚═════╝ ╚══════╝ ╚═════╝╚═╝  ╚═╝
EOF
  printf '%s%s               a workspace for parallel terminals%s%s\n' "$RESET" "$DIM" "${version:+ · v$version}" "$RESET"
  typing "$1"
}

# The last word of a run: a headline and the lines under it.
closing() {
  printf '\n    %s%s━━━%s %s%s%s%s\n' "$TEAL" "$BOLD" "$RESET" "$WHITE" "$BOLD" "$1" "$RESET"
  shift
  for line in "$@"; do
    printf '        %s\n' "$line"
  done
  printf '\n'
}

# The sign-off of an install that worked, warnings or not.
chromed() {
  closing "preem, choom. you're chromed." "$@"
}

has() {
  command -v "$1" > /dev/null 2>&1
}

# Linux on x86_64, and macOS on either architecture, as its app is universal; Windows has
# its own installer. Prints linux or mac.
check_platform() {
  repository="$1"
  case "$(uname -s)" in
    Linux) ;;
    Darwin)
      printf 'mac\n'
      return 0
      ;;
    *)
      fail "this installer is for Linux and macOS. On Windows, download https://github.com/$repository/releases/latest/download/novadeck-win-x64-setup.exe."
      ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) ;;
    *) fail "Novadeck is built for x86_64 only on Linux, and this computer is $(uname -m)." ;;
  esac
  printf 'linux\n'
}

# The path of a system tool: the one in the system folders, which a user's PATH often
# lacks, else the one on the PATH, or nothing when it is nowhere. The system folders come
# first, as the tool may run as root, and a folder early on the PATH may be the user's.
find_tool() {
  # shellcheck disable=SC2086
  for dir in ${NOVADECK_INSTALL_SBIN_DIRS:-/sbin /usr/sbin}; do
    if [ -x "$dir/$1" ]; then
      printf '%s\n' "$dir/$1"
      return 0
    fi
  done
  if has "$1"; then
    command -v "$1"
  fi
}

download() {
  curl -fsSL --retry 3 --retry-connrefused -o "$2" "$1" || fail "could not download $1"
}

# A package, with curl's progress bar on a terminal, which goes once the download is done.
download_package() {
  if [ "$ANIMATE" = true ] && [ -t 2 ]; then
    curl -fSL --progress-bar --retry 3 --retry-connrefused -o "$2" "$1" || fail "could not download $1"
    printf '\033[1A\033[2K' >&2
  else
    download "$1" "$2"
  fi
}

# A file's size in megabytes, or nothing when wc cannot tell.
size() {
  wc -c < "$1" 2> /dev/null | awk '{ printf "%.0f MB\n", $1 / 1000000 }' || true
}

# A file's SHA-256, through sha256sum on Linux and shasum on macOS, which may lack it.
checksum() {
  if has sha256sum; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi | awk '{ print $1 }'
}

# Succeeds only when the file's SHA-256 is the one SHA256SUMS lists for its name.
verify() {
  name="$1"
  expected="$(awk -v name="$name" '$2 == name || $2 == "*" name { print $1; exit }' SHA256SUMS)"
  [ -n "$expected" ] || fail "SHA256SUMS lists no $name."
  actual="$(checksum "$name")"
  [ "$expected" = "$actual" ] || fail "$name does not match its checksum in SHA256SUMS; try again, and report it if it persists."
}

# Checks the file's build attestation with the GitHub CLI when it is installed, signed in to
# github.com and new enough to have `gh attestation`. The checksums come from the same release
# as the file, so they show a download came whole, not that this repository's release workflow
# built it; the attestation does. It fails only when gh reports that the attestation does not
# hold (none for this file, or a signature, digest or signer that does not match); when gh
# cannot tell, as with no network or a proxy in the way, it says so and goes on with the
# checksums. Without gh it says plainly that only the checksums were checked.
attest() {
  if ! has gh; then
    warn "attestation $(quiet "not checked, checksums only: install the GitHub CLI (gh) to check it too")"
  elif ! gh attestation verify --help > /dev/null 2>&1; then
    warn "attestation $(quiet "not checked, checksums only: this version of gh has no 'gh attestation'")"
  elif ! gh auth status --hostname github.com > /dev/null 2>&1; then
    warn "attestation $(quiet "not checked, checksums only: sign in with 'gh auth login' to check it too")"
  else
    if output="$(gh attestation verify "$1" --repo "$repository" --hostname github.com --signer-workflow "$repository/.github/workflows/release.yml" 2>&1)"; then
      ok "attestation $(quiet "built by $repository's release workflow")"
    elif printf '%s\n' "$output" | grep -Eiq 'no attestations? found|no matching attestation|verifying with issuer|verification failed|failed to verify|digest|signature|mismatch|does not match'; then
      printf '%s\n' "$output" >&2
      fail "$1 has no valid build attestation from $repository; do not use it, and report it if it persists."
    else
      printf '%s\n' "$output" >&2
      warn "attestation $(quiet "could not be verified, gh could not check it (see above); checksums only")"
    fi
  fi
}

fetch() {
  base="$1"
  name="$2"
  section "downloading"
  download_package "$base/$name" "$name"
  megabytes="$(size "$name")"
  say "$name${megabytes:+ $(quiet "$megabytes")}"
  verify "$name"
  ok "checksum $(quiet "matches SHA256SUMS")"
  attest "$name"
}

# Runs a command as root, through sudo unless this already is root. It fails, quietly, when
# there is no way to become root, and when sudo is declined.
as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif has sudo; then
    sudo "$@"
  else
    return 1
  fi
}

# An AppImage mounts itself through fusermount and /dev/fuse. The static runtime takes any
# setuid fusermount* on the PATH, FUSE 2's fusermount included, so either one will do; it
# does not look in the system folders, and neither does this.
check_fuse() {
  if has fusermount3 || has fusermount; then
    if [ -e "${NOVADECK_INSTALL_FUSE_DEVICE:-/dev/fuse}" ]; then
      ok "fusermount"
      return 0
    fi
  fi
  warn "fusermount $(quiet "missing: the AppImage needs FUSE 3 to start. Install your")"
  say "  $(quiet "distribution's fuse3 package, or start Novadeck with --appimage-extract-and-run.")"
}

# XDG_DATA_HOME, which the XDG spec says to ignore unless it is an absolute path.
data_home() {
  case "${XDG_DATA_HOME:-}" in
    /*) printf '%s\n' "$XDG_DATA_HOME" ;;
    *) printf '%s\n' "$HOME/.local/share" ;;
  esac
}

# Where the AppImage lives; the sandbox profile names this path.
image_path() {
  printf '%s\n' "$(data_home)/novadeck/novadeck.AppImage"
}

# A path as the inside of a quoted Exec argument in a desktop entry. The spec escapes ",
# `, $ and \ with a backslash, and then, as Exec is a string, every backslash again; a
# percent sign is doubled, as it starts a field code.
exec_quote() {
  printf '%s\n' "$1" | sed -e 's/\\/\\\\\\\\/g' -e 's/["`$]/\\\\&/g' -e 's/%/%%/g'
}

install_appimage() {
  base="$1"
  data="$(data_home)"
  bin="$HOME/.local/bin"
  folder="$data/novadeck"
  image="$(image_path)"

  say "installs to $(quiet "$(tidy "$folder")")"
  fetch "$base" novadeck-linux-x86_64.AppImage
  chmod +x novadeck-linux-x86_64.AppImage
  section "installing"

  # The icon comes out of the AppImage without mounting it, so this needs no FUSE.
  icon=""
  if ./novadeck-linux-x86_64.AppImage --appimage-extract usr/share/icons/hicolor/512x512/apps/novadeck.png > /dev/null 2>&1 &&
    [ -f squashfs-root/usr/share/icons/hicolor/512x512/apps/novadeck.png ]; then
    icon="$data/icons/hicolor/512x512/apps/novadeck.png"
    mkdir -p "$data/icons/hicolor/512x512/apps"
    cp squashfs-root/usr/share/icons/hicolor/512x512/apps/novadeck.png "$icon"
  else
    warn "icon $(quiet "could not be extracted; the menu entry has none")"
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
Name=Novadeck
Comment=A workspace for parallel terminals.
Exec="$(exec_quote "$image")" %U
Icon=${icon:-novadeck}
Terminal=false
Categories=Utility;
StartupWMClass=dev.mzpk.novadeck
EOF

  say "app        $(quiet "→ $(tidy "$image")")"
  say "command    $(quiet "→ $(tidy "$bin/novadeck")")"
  say "menu entry $(quiet "→ Novadeck")"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) warn "PATH $(quiet "lacks $(tidy "$bin"); add it to your PATH to start Novadeck as \`novadeck\`:")"
       say "  $(quiet "export PATH=\"$bin:\$PATH\"")" ;;
  esac
  check_fuse
  setup_sandbox "$base"
}

# The path AppArmor matches for a file: the real one, with symlinks resolved. For a file
# that is not there yet, it is the real path of the nearest folder that is, and the rest
# as written.
canonical_path() {
  folder="${1%/*}"
  rest="${1##*/}"
  # A relative path has no slash left to strip at some point, and stops there.
  while [ -n "$folder" ] && [ ! -d "$folder" ] && [ "$folder" != "${folder%/*}" ]; do
    rest="${folder##*/}/$rest"
    folder="${folder%/*}"
  done
  if [ -e "$1" ]; then
    readlink -f "$1"
  else
    folder="$(readlink -f "${folder:-/}")"
    printf '%s/%s\n' "${folder%/}" "$rest"
  fi
}

# One profile: it lets the program at one path create user namespaces and leaves
# everything else about it unconfined. A quoted attachment takes a single literal path.
profile_block() {
  printf 'profile %s "%s" flags=(unconfined) {\n  userns,\n  include if exists <local/%s>\n}\n' "$1" "$2" "$1"
}

# The AppArmor profiles for this user's AppImage, and for the one Homebrew's cask puts in
# ~/Applications. The abi line makes AppArmor 3 and earlier, which lack it, reject the
# file; the dry run in setup_sandbox catches that.
write_profile() {
  name="novadeck-appimage-$1"
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\n\n'
  profile_block "$name" "$2"
  if [ "$2" != "$3" ]; then
    printf '\n'
    profile_block "$name-brew" "$3"
  fi
}

sandbox_warning() {
  bad "Novadeck will run without its sandbox: $(quiet "$1")"
  say "  $(quiet "To set it up later, run:")"
  say "  curl -fsSL $2/install.sh | sh -s -- --sandbox"
}

# True when AppArmor stops unprivileged programs from creating user namespaces, which is
# what Electron's sandbox needs; Ubuntu 24.04 and later do. Without that sysctl there is
# nothing to fix.
userns_restricted() {
  [ "$(cat "${NOVADECK_INSTALL_USERNS_SYSCTL:-/proc/sys/kernel/apparmor_restrict_unprivileged_userns}" 2> /dev/null || true)" = 1 ]
}

# True when the kernel already has a profile of that name. Anyone can list the folder of
# loaded profiles, unlike the file of their names that only root may read.
profile_loaded() {
  for entry in "${NOVADECK_INSTALL_PROFILES:-/sys/kernel/security/apparmor/policy/profiles}"/*; do
    [ "$(cat "$entry/name" 2> /dev/null || true)" = "$1" ] && return 0
  done
  return 1
}

# The numeric owner of the home folder.
home_owner() {
  # shellcheck disable=SC2012
  ls -ndL "$HOME" | awk '{ print $3 }'
}

# Lets the AppImage create user namespaces by loading an AppArmor profile. A failure here
# only costs the sandbox, so it warns and returns instead of failing the install.
setup_sandbox() {
  base="$1"
  userns_restricted || return 0
  section "sandbox"
  parser="$(find_tool apparmor_parser)"
  if [ -z "$parser" ]; then
    sandbox_warning "apparmor_parser, which loads the profile, is not installed." "$base"
    return 0
  fi

  uid="$(id -u)"

  # One file per user, named for the uid, so one user's install never replaces another's,
  # and apart from the novadeck name the .deb's own profile uses.
  name="novadeck-appimage-$uid"
  target="${NOVADECK_INSTALL_APPARMOR_DIR:-/etc/apparmor.d}/$name"
  location="$(canonical_path "$(image_path)")"
  brew="$(canonical_path "$HOME/Applications/novadeck.AppImage")"
  for path in "$location" "$brew"; do
    case "$path" in
      *[\"{}\[\]*?^,\\]* | *[[:cntrl:]]*)
        sandbox_warning "the path $path has characters AppArmor profiles cannot name." "$base"
        return 0
        ;;
    esac
  done
  profile="$work/profile"
  write_profile "$uid" "$location" "$brew" > "$profile"
  # AppArmor 3 and earlier lack the abi file, and fail here before anything is installed.
  if ! "$parser" --skip-kernel-load --debug "$profile" > /dev/null 2>&1; then
    sandbox_warning "this system's AppArmor rejected the profile." "$base"
    return 0
  fi
  brewname="$name-brew"
  if cmp -s "$profile" "$target" && profile_loaded "$name" && { [ "$location" = "$brew" ] || profile_loaded "$brewname"; }; then
    ok "sandbox $(quiet "already set up")"
    return 0
  fi
  say "Writing an AppArmor profile so Novadeck's sandbox works on this system."
  say "$(quiet "This system restricts user namespaces; sudo may ask for your password once.")"
  # Loaded before it is saved, so a profile that will not load never replaces a working one
  # and never loads at the next boot.
  if ! as_root "$parser" --replace "$profile" > /dev/null; then
    sandbox_warning "the profile could not be loaded as root." "$base"
  elif as_root cp "$profile" "$target"; then
    ok "sandbox $(quiet "set up")"
  else
    warn "sandbox $(quiet "works until the next restart, as the profile could not be saved.")"
    say "  $(quiet "After a restart, run this again:")"
    say "  curl -fsSL $base/install.sh | sh -s -- --sandbox"
  fi
}

# The folder the macOS app goes to: the one that already holds it, else /Applications when
# this account may write to it, as an administrator's may, else ~/Applications. macOS
# updates an app only where it is, so it must stay where this account can replace it.
mac_folder() {
  system="${NOVADECK_INSTALL_APPLICATIONS_DIR:-/Applications}"
  user="$HOME/Applications"
  if [ -e "$system/novadeck.app" ]; then
    if [ -w "$system" ] && [ -w "$system/novadeck.app" ]; then
      printf '%s\n' "$system"
    else
      fail "Novadeck in $system is not this account's to replace. Run this as the account that installed it, or remove that copy and run this again."
    fi
  elif [ -e "$user/novadeck.app" ] || [ ! -w "$system" ]; then
    printf '%s\n' "$user"
  else
    printf '%s\n' "$system"
  fi
}

# Whether `codesign` finds a Developer ID signature on the app, which macOS needs before
# it installs an update.
developer_id_signed() {
  codesign --display --verbose=2 "$1" 2>&1 | grep -q '^Authority=Developer ID Application: '
}

# True when Novadeck runs from that app. The app's command line starts with its
# executable's path, taken as plain text. The path goes in through the environment, as
# awk -v would read its backslashes as escapes.
mac_running() {
  ps -axo command= 2> /dev/null | NOVADECK_APP="$1/Contents/MacOS/" awk 'index($0, ENVIRON["NOVADECK_APP"]) == 1 { found = 1 } END { exit !found }'
}

install_mac() {
  base="$1"
  folder="$(mac_folder)" || exit 1
  app="$folder/novadeck.app"

  say "installs to $(quiet "$(tidy "$folder")")"
  fetch "$base" novadeck-mac-universal.zip
  section "installing"

  # Replacing the app under a running copy would leave it starting helpers of another
  # version.
  if mac_running "$app"; then
    fail "Novadeck is running from $app. Quit it and run this again."
  fi

  # Unpacked next to the app, so it moves into place in one rename. ditto keeps the
  # bundle's symlinks and signature intact, and curl leaves the download unquarantined.
  # The folder's name is new each run, so one an earlier run could not remove is no
  # obstacle.
  mkdir -p "$folder"
  staging="$(mktemp -d "$folder/.novadeck-install.XXXXXX")" || fail "could not create a folder in $folder."
  ditto -x -k novadeck-mac-universal.zip "$staging" || fail "could not unpack novadeck-mac-universal.zip."
  [ -d "$staging/novadeck.app" ] || fail "novadeck-mac-universal.zip holds no novadeck.app."
  # Between the two renames the old copy is only in the folder the exit removes, so
  # interrupts are ignored until both are done.
  trap '' INT HUP QUIT TERM
  if [ -e "$app" ] && ! mv "$app" "$staging/previous.app"; then
    warn "If macOS said your terminal was prevented from modifying apps, allow it under"
    say "  System Settings > Privacy & Security > App Management, then run this again."
    fail "could not replace $app."
  fi
  if ! mv "$staging/novadeck.app" "$app"; then
    if [ -e "$staging/previous.app" ] && ! mv "$staging/previous.app" "$app"; then
      # Kept, as the earlier copy is in it.
      kept="$staging"
      staging=""
      fail "could not move Novadeck into $folder, nor put back the copy that was there, which is now $kept/previous.app."
    fi
    fail "could not move Novadeck into $folder."
  fi
  trap 'exit 130' INT HUP TERM
  trap - QUIT
  # What is left there, such as the copy it replaced, costs only space.
  if ! rm -rf "$staging" 2> /dev/null; then
    warn "Could not remove $(tidy "$staging"); delete it by hand."
  fi
  staging=""

  say "app $(quiet "→ $(tidy "$app")")"
  if developer_id_signed "$app"; then
    ok "signed $(quiet "Developer ID")"
    chromed "Open it from Launchpad or Spotlight. Novadeck updates itself from here."
  else
    warn "unsigned build $(quiet "— Novadeck tells you of new versions rather than installing")"
    say "  $(quiet "them; run this again to install one.")"
    chromed "Open it from Launchpad or Spotlight."
  fi
}

# Succeeds when Homebrew manages Novadeck: its cask folder holds novadeck, or the installed
# copy at the given path, if any, links into a Caskroom. Such a copy is Homebrew's to
# remove, and removing it behind its back leaves it believing the cask is installed.
homebrew_managed() {
  # shellcheck disable=SC2086
  for dir in ${NOVADECK_INSTALL_CASKROOMS:-/opt/homebrew/Caskroom /usr/local/Caskroom /home/linuxbrew/.linuxbrew/Caskroom}; do
    [ -e "$dir/novadeck" ] && return 0
  done
  for path in "$@"; do
    if [ -L "$path" ]; then
      case "$(readlink -f "$path")" in
        */Caskroom/*) return 0 ;;
      esac
    fi
  done
  return 1
}

# What stays after an uninstall, and how to remove it: Novadeck cannot know which agents
# have its plugin, and the data is the person's.
# XDG_CONFIG_HOME, where Electron keeps the app's data on Linux; like XDG_DATA_HOME, it
# counts as unset unless it is an absolute path.
config_home() {
  case "${XDG_CONFIG_HOME:-}" in
    /*) printf '%s\n' "$XDG_CONFIG_HOME" ;;
    *) printf '%s\n' "$HOME/.config" ;;
  esac
}

uninstall_leftovers() {
  section "kept"
  say "your data $(quiet "— delete $1 to remove it")"
  say "agent plugins $(quiet "— each agent you connected removes its own:")"
  say "  claude plugin uninstall novadeck@novadeck && claude plugin marketplace remove novadeck"
  say "  codex plugin remove novadeck@novadeck && codex plugin marketplace remove novadeck"
  say "  agy plugin uninstall novadeck"
}

# One thing the uninstall removed, under a heading that comes with the first.
removed() {
  [ "$found" = true ] || section "removing"
  found=true
  gone "$1"
}

# The sign-off of an uninstall: what went, or that nothing was there.
unplugged() {
  if [ "$found" = false ]; then
    closing "nothing to unplug, choom." "Novadeck is not installed, so there is nothing to remove."
    return 0
  fi
  uninstall_leftovers "$1"
  closing "chrome's out, choom. stay preem." "Come back any time: curl -fsSL https://novadeck.dev/install.sh | sh"
}

uninstall_sandbox() {
  base="$1"
  target="${NOVADECK_INSTALL_APPARMOR_DIR:-/etc/apparmor.d}/novadeck-appimage-$(id -u)"
  [ -e "$target" ] || return 1
  removed "AppArmor profile $(quiet "${target##*/}")"
  parser="$(find_tool apparmor_parser)"
  # Unloaded from the file that loaded it, then the file goes, so it never loads again. An
  # unload that fails, as the profile is not loaded, still leaves the file to remove.
  unloaded=false
  if [ -n "$parser" ] && as_root "$parser" --remove "$target" > /dev/null 2>&1; then
    unloaded=true
  fi
  if as_root rm -f "$target"; then
    if [ "$unloaded" = false ]; then
      say "  $(quiet "Novadeck's profile stays loaded until the next restart, if it is loaded at all.")"
    fi
  else
    bad "the profile could not be removed as root. $(quiet "To finish, run:")"
    say "  curl -fsSL $base/install.sh | sh -s -- --uninstall"
  fi
  return 0
}

uninstall_appimage() {
  base="$1"
  data="$(data_home)"
  folder="$data/novadeck"
  image="$(image_path)"
  link="$HOME/.local/bin/novadeck"
  found=false

  if homebrew_managed "$HOME/Applications/novadeck.AppImage" "$image"; then
    fail "Homebrew installed Novadeck. Run \`brew uninstall --cask novadeck\` instead."
  fi

  # Only the command this install made: one that points elsewhere is someone else's.
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$image" ]; then
    rm -f "$link"
    removed "$(tidy "$link")"
  fi
  for file in "$image" "$data/applications/dev.mzpk.novadeck.desktop" "$data/icons/hicolor/512x512/apps/novadeck.png"; do
    if [ -e "$file" ] || [ -L "$file" ]; then
      rm -f "$file"
      removed "$(tidy "$file")"
    fi
  done
  # The folder also holds the person's data, so it goes only when nothing else is in it.
  if [ -d "$folder" ]; then
    rmdir "$folder" 2> /dev/null && removed "$(tidy "$folder")"
  fi
  uninstall_sandbox "$base" || true

  if [ -d "$folder" ]; then
    unplugged "$(tidy "$(config_home)/novadeck") and $(tidy "$folder")"
  else
    unplugged "$(tidy "$(config_home)/novadeck")"
  fi
}

uninstall_mac() {
  system="${NOVADECK_INSTALL_APPLICATIONS_DIR:-/Applications}"
  found=false

  if homebrew_managed "$system/novadeck.app" "$HOME/Applications/novadeck.app"; then
    fail "Homebrew installed Novadeck. Run \`brew uninstall --cask novadeck\` instead."
  fi

  for folder in "$system" "$HOME/Applications"; do
    app="$folder/novadeck.app"
    # A bundle is a folder; a link or a file by this name is not what the install made.
    if [ -L "$app" ] || [ ! -d "$app" ]; then
      continue
    fi
    if mac_running "$app"; then
      fail "Novadeck is running from $app. Quit it and run this again."
    fi
    # To the Trash, where it can be fetched back, by a move: Finder's AppleScript asks
    # permission to control Finder, and fails over ssh, while a move asks nothing.
    trash="$HOME/.Trash"
    mkdir -p "$trash"
    destination="$trash/novadeck.app"
    if [ -e "$destination" ]; then
      destination="$trash/novadeck.$$.app"
    fi
    if ! mv "$app" "$destination"; then
      warn "If macOS said your terminal was prevented from modifying apps, allow it under"
      say "  System Settings > Privacy & Security > App Management, then run this again."
      fail "could not move $app to the Trash."
    fi
    removed "$(tidy "$app") $(quiet "moved to the Trash")"
  done

  unplugged "$(tidy "$HOME/Library/Application Support/novadeck")"
}

usage() {
  printf 'usage: install.sh [--sandbox | --uninstall]\n' >&2
  exit 2
}

main() {
  set -eu
  sandbox_only=false
  uninstall=false
  for arg in "$@"; do
    case "$arg" in
      --sandbox) sandbox_only=true ;;
      --uninstall) uninstall=true ;;
      *) usage ;;
    esac
  done
  if [ "$sandbox_only" = true ] && [ "$uninstall" = true ]; then
    usage
  fi
  repository='@REPOSITORY@'
  # Unrendered, as in a checkout, the placeholder names no version.
  version='@VERSION@'
  case "$version" in
    @*@) version="" ;;
  esac
  style
  if [ "$uninstall" = true ]; then
    banner "jacking out…"
  else
    banner "jacking in…"
  fi
  base="${NOVADECK_INSTALL_BASE_URL:-https://github.com/$repository/releases/latest/download}"
  base="${base%/}"

  platform="$(check_platform "$repository")" || exit 1

  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
    fail "HOME is not set to an existing folder."
  fi
  # Run through sudo, whether plain (HOME is root's) or with -E (HOME is the user's), this
  # would write everything as root, out of reach of the user's own updates and re-runs, and
  # Electron will not start as root with a sandbox. Real root logins set no SUDO_UID.
  if [ "$(id -u)" = 0 ] && { [ "${SUDO_UID:-0}" != 0 ] || [ "$(home_owner)" != 0 ]; }; then
    fail "this is running as root for another user's account. Run install.sh as the user who runs Novadeck, without sudo."
  fi

  work="$(mktemp -d)" || fail "could not create a temporary folder."
  staging=""
  trap 'rm -rf "$work" ${staging:+"$staging"}' EXIT
  # Not every shell runs the exit trap when a signal ends it, so an interrupt exits instead.
  trap 'exit 130' INT HUP TERM
  cd "$work" || fail "could not enter $work."

  if [ "$uninstall" = true ]; then
    if [ "$platform" = mac ]; then
      uninstall_mac
    else
      uninstall_appimage "$base"
    fi
    return 0
  fi
  if [ "$sandbox_only" = true ] && [ "$platform" = mac ]; then
    section "sandbox"
    ok "Novadeck's sandbox needs no setup on macOS."
    printf '\n'
    return 0
  fi
  if [ "$sandbox_only" = true ]; then
    if userns_restricted; then
      setup_sandbox "$base"
    else
      section "sandbox"
      ok "This system does not restrict user namespaces, so Novadeck's sandbox needs no setup."
    fi
    printf '\n'
    return 0
  fi

  has curl || fail "curl is required."
  has sha256sum || has shasum || fail "sha256sum is required."

  section "preflight"
  if [ "$platform" = mac ]; then
    say "macOS $(uname -m)"
  else
    say "linux x86_64"
  fi
  download "$base/SHA256SUMS" SHA256SUMS
  if [ "$platform" = mac ]; then
    install_mac "$base"
  else
    install_appimage "$base"
    chromed "Start it from your app menu, or run \`novadeck\`." "Novadeck updates itself from here."
  fi
}

main "$@"
