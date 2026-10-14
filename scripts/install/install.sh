#!/bin/sh
# Installs the latest stable Novadeck on x86_64 Linux and on macOS:
#
#   curl -fsSL https://github.com/@REPOSITORY@/releases/latest/download/install.sh | sh
#
# On Linux it puts the AppImage in ~/.local/share/novadeck with a menu entry and a
# `novadeck` command. On macOS it puts the app in /Applications, or in ~/Applications when
# this account cannot write to /Applications, and replaces a copy already in either.
# Every download is checked against the release's SHA256SUMS first. Running it again
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
# The release workflow replaces @REPOSITORY@ with the repository it publishes from. These
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

fetch() {
  base="$1"
  name="$2"
  say "Downloading $name"
  download "$base/$name" "$name"
  verify "$name"
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
      return 0
    fi
  fi
  say "Novadeck's AppImage needs FUSE 3, which this computer seems to lack."
  say "Install your distribution's fuse3 package, or start Novadeck with"
  say "--appimage-extract-and-run."
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
Name=Novadeck
Comment=A workspace for parallel terminals.
Exec="$(exec_quote "$image")" %U
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
  say "Warning: Novadeck will run without its sandbox: $1"
  say "To set it up later, run:"
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
    say "Novadeck's sandbox is already set up."
    return 0
  fi
  say "Writing an AppArmor profile so Novadeck's sandbox works on this system."
  # Loaded before it is saved, so a profile that will not load never replaces a working one
  # and never loads at the next boot.
  if ! as_root "$parser" --replace "$profile" > /dev/null; then
    sandbox_warning "the profile could not be loaded as root." "$base"
  elif as_root cp "$profile" "$target"; then
    say "Novadeck's sandbox is set up."
  else
    say "Novadeck's sandbox works until the next restart, as the profile could not be saved."
    say "After a restart, run this again:"
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

  fetch "$base" novadeck-mac-universal.zip

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
    say "If macOS said your terminal was prevented from modifying apps, allow it under System"
    say "Settings > Privacy & Security > App Management, then run this again."
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
    say "Could not remove $staging; delete it by hand."
  fi
  staging=""

  say "Installed Novadeck to $app"
  if developer_id_signed "$app"; then
    say "Done. Novadeck updates itself from here."
  else
    say "Done. This build is not signed, so Novadeck tells you of new versions rather than"
    say "installing them; run this again to install one."
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
  say "Your data and any agent plugins stay. To remove the data, delete $1."
  say "To remove the plugin from an agent you connected, run its own command:"
  say "  claude plugin uninstall novadeck@novadeck && claude plugin marketplace remove novadeck"
  say "  codex plugin remove novadeck@novadeck && codex plugin marketplace remove novadeck"
  say "  agy plugin uninstall novadeck"
}

uninstall_sandbox() {
  base="$1"
  target="${NOVADECK_INSTALL_APPARMOR_DIR:-/etc/apparmor.d}/novadeck-appimage-$(id -u)"
  [ -e "$target" ] || return 1
  say "Removing Novadeck's AppArmor profile."
  parser="$(find_tool apparmor_parser)"
  # Unloaded from the file that loaded it, then the file goes, so it never loads again. An
  # unload that fails, as the profile is not loaded, still leaves the file to remove.
  unloaded=false
  if [ -n "$parser" ] && as_root "$parser" --remove "$target" > /dev/null 2>&1; then
    unloaded=true
  fi
  if as_root rm -f "$target"; then
    if [ "$unloaded" = false ]; then
      say "Novadeck's profile stays loaded until the next restart, if it is loaded at all."
    fi
  else
    say "Warning: the profile could not be removed as root."
    say "To finish, run:"
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
    say "Removed $link"
    found=true
  fi
  for file in "$image" "$data/applications/dev.mzpk.novadeck.desktop" "$data/icons/hicolor/512x512/apps/novadeck.png"; do
    if [ -e "$file" ] || [ -L "$file" ]; then
      rm -f "$file"
      say "Removed $file"
      found=true
    fi
  done
  # The folder also holds the person's data, so it goes only when nothing else is in it.
  if [ -d "$folder" ]; then
    rmdir "$folder" 2> /dev/null && say "Removed $folder"
  fi
  if uninstall_sandbox "$base"; then
    found=true
  fi

  if [ "$found" = false ]; then
    say "Novadeck is not installed, so there is nothing to remove."
    return 0
  fi
  say "Done."
  if [ -d "$folder" ]; then
    uninstall_leftovers "$(config_home)/novadeck and $folder"
  else
    uninstall_leftovers "$(config_home)/novadeck"
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
      say "If macOS said your terminal was prevented from modifying apps, allow it under System"
      say "Settings > Privacy & Security > App Management, then run this again."
      fail "could not move $app to the Trash."
    fi
    say "Moved $app to the Trash"
    found=true
  done

  if [ "$found" = false ]; then
    say "Novadeck is not installed, so there is nothing to remove."
    return 0
  fi
  say "Done."
  uninstall_leftovers "$HOME/Library/Application Support/novadeck"
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
    say "Novadeck's sandbox needs no setup on macOS."
    return 0
  fi
  if [ "$sandbox_only" = true ]; then
    userns_restricted || say "This system does not restrict user namespaces, so Novadeck's sandbox needs no setup."
    setup_sandbox "$base"
    return 0
  fi

  has curl || fail "curl is required."
  has sha256sum || has shasum || fail "sha256sum is required."

  say "Installing Novadeck"
  download "$base/SHA256SUMS" SHA256SUMS
  if [ "$platform" = mac ]; then
    install_mac "$base"
  else
    install_appimage "$base"
    say "Done. Novadeck updates itself from here."
  fi
}

main "$@"
