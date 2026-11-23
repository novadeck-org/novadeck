import type { File } from "@novadeck/harness-core/harness"
import { header } from "@novadeck/harness-core/header"

// On Linux, what an agent leaves in its terminal's systemd scope ends with the terminal
// (libraries/terminal/src/pty/leftovers.ts). An app it opens for the person is no leftover:
// a browser's first window, an editor or a viewer the person goes on working in. Yet
// `xdg-open` and `gio open` start it in the caller's own cgroup (GLib 2.90 on GNOME, measured
// 2026-11-23), so closing the terminal would close it, tabs and unsaved work with it. These
// shims, first on PATH in Novadeck's terminals, hand the real program to the user's systemd
// in a scope of its own, which outlives the terminal; `BROWSER` names the `xdg-open` one where
// the person names no browser of their own. The rest is the real program's: its words, what
// it prints and its exit status, as `systemd-run --scope` runs it in the foreground. Where the
// terminal has no scope, or the user's systemd doesn't answer (inside Codex's sandbox), the
// program runs as it would without the shim. An app started any other way, as by its own
// binary, stays the agent's and ends with the terminal.

/** The programs shimmed, each by the words that open something. */
const programs = {
  "xdg-open": undefined,
  // `gio`'s other commands (`info`, `mount`, ...) run as they are.
  gio: ["open", "launch"],
} as const satisfies { readonly [program: string]: readonly string[] | undefined }

export type OpenProgram = keyof typeof programs

/** The shim for `program`: the real one, found later on PATH, in a scope of its own. */
export const openShim = (program: OpenProgram): string => {
  const opening = programs[program]
  return `#!/bin/sh
${header("#", `shim for ${program}`)}
# Runs the real ${program} in a systemd scope of its own, so what it opens outlives the
# terminal it was opened from, as an app opened from the desktop does.
novadeck_real=
novadeck_ifs=$IFS
IFS=:
set -f
for novadeck_dir in $PATH; do
  [ -n "$novadeck_dir" ] || continue
  novadeck_candidate=$novadeck_dir/${program}
  # Another Novadeck's shim, as from a runner started in a Novadeck terminal, would call
  # this one back: only the program itself counts.
  if [ -f "$novadeck_candidate" ] && [ -x "$novadeck_candidate" ] && ! [ "$novadeck_candidate" -ef "$0" ] &&
    ! head -c 256 "$novadeck_candidate" 2>/dev/null | grep -qi "novadeck shim for ${program}"; then
    novadeck_real=$novadeck_candidate
    break
  fi
done
set +f
IFS=$novadeck_ifs
if [ -z "$novadeck_real" ]; then
  echo "${program}: command not found" >&2
  exit 127
fi
# Only in a terminal Novadeck keeps in a scope of its own.
[ -n "\${NOVADECK_SCOPED:-}" ] || exec "$novadeck_real" "$@"
${
  opening === undefined
    ? ""
    : `case "\${1:-}" in ${opening.join(" | ")}) ;; *) exec "$novadeck_real" "$@" ;; esac\n`
}command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 ||
  exec "$novadeck_real" "$@"
exec systemd-run --user --scope --collect --quiet -- "$novadeck_real" "$@"
`
}

/** The shims Novadeck's bin holds on `platform`: Linux's alone, where terminals have scopes. */
export const openShims = (platform: NodeJS.Platform): readonly File[] =>
  platform === "linux"
    ? (Object.keys(programs) as OpenProgram[]).map((program) => ({
        path: program,
        content: openShim(program),
        mode: 0o755,
      }))
    : []
