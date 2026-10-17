# The sandbox's own `security` on macOS (see `keychainGuard` in keychain.ts), after the two
# lines that set `log`, where each service asked for is written, and `real`, the system's
# `security`. It answers "not found" (exit 44), passing nothing on, where any service
# asked for is one of Claude Code's items with no folder's suffix: the person's own.

# Writes the service to the log; fails where it is the person's own Claude Code item.
asked() {
  printf '%s\n' "$1" >> "$log"
  case "$1" in
    "Claude Code"*-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) return 0 ;;
    "Claude Code"*) return 1 ;;
  esac
  return 0
}

# The text tools read bytes, whatever the sandbox's locale: a byte that isn't valid UTF-8
# can't break a match.
export LC_ALL=C

refused=

# Interactive (-i) only among the global options before the subcommand, as getopt reads
# them: combined as -qi too, and never an -i that is an option's value, as in `-a -i`.
interactive=
skip=
for argument in "$@"; do
  if [ -n "$skip" ]; then
    skip=
    continue
  fi
  case "$argument" in
    -p) skip=1 ;;
    -p*) ;;
    --) break ;;
    -*i*) interactive=1 ;;
    -*) ;;
    *) break ;;
  esac
done

previous=
for argument in "$@"; do
  if [ "$previous" = "-s" ]; then
    asked "$argument" || refused=1
  else
    case "$argument" in
      # A service joined to its flag, as `-sName`.
      -s?*) asked "${argument#-s}" || refused=1 ;;
    esac
  fi
  previous=$argument
done

# With -i, the commands come on its input, as Claude Code writes its items. Every Claude
# Code item the input names counts, whatever its layout (spaces, tabs, either quote, none,
# `Claude\ Code`): a hex value or an account can't hold "Claude Code" with its space. The
# input is passed on as it came.
if [ -n "$interactive" ]; then
  input=$(cat; printf x)
  input=${input%x}
  items=$(printf '%s' "$input" | grep -o "Claude\\\\\{0,1\} Code[^\"'[:space:]]*" | sed 's/\\ / /')
  while IFS= read -r item; do
    [ -n "$item" ] && { asked "$item" || refused=1; }
  done <<EOF
$items
EOF
  [ -n "$refused" ] && exit 44
  # A pipeline runs in a subshell of its own: its status is the script's, and it ends here.
  printf '%s' "$input" | "$real" "$@"
  exit $?
fi

[ -n "$refused" ] && exit 44
exec "$real" "$@"
