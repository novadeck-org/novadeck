// Antigravity in a narrowed terminal: one started or resumed while the person's grant covers
// it, with `--settings` allowing the granted programs and NOVADECK_NARROW=1 in its env (see
// approvals-design.md, Appendix B). Its PreToolUse then decides every call, and a hook that
// prints nothing, or fails, lets a granted program run unasked, so every answer path prints
// one of these three lines, and "closed" is the one for anything else.

/** Runs a call of a granted program with no dialog; fails any other call. */
export const runAnswer = '{"decision":"deny_unless_prior_grant"}'

/** Puts the "Run this command?" dialog back, over every other handler's answer. */
export const closedAnswer = '{"decision":"force_ask"}'

/**
 * Refuses a call the person's own rules may deny. `force_ask` would put a dialog over their
 * `deny` (probed 2026-11-01, 1.4.12: approvals-agy m23), so a command their rules could deny
 * is refused here instead, never asked.
 */
export const deniedAnswer =
  '{"decision":"deny","reason":"novadeck: your own Antigravity rules may deny this command"}'

/** A tool known to run no command keeps today's plain ask. */
export const notCommandAnswer = '{"decision":"ask","reason":"novadeck: not a command"}'

/** The first Antigravity that takes `--settings` (probed 1.4.10; 1.4.3 rejects the flag and exits). */
export const minLaunchVersion: readonly number[] = [1, 4, 10]

/** Whether `agy --version`'s output names a version of at least `minLaunchVersion`; unknown is no. */
export const takesSettings = (output: string): boolean => {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  if (!found) return false
  const version = found.slice(1).map(Number)
  for (const [index, least] of minLaunchVersion.entries()) {
    const have = version[index] ?? 0
    if (have !== least) return have > least
  }
  return true
}

/** The only answers a narrowed terminal's hook command passes on. */
export const narrowedAnswers: readonly string[] = [
  runAnswer,
  closedAnswer,
  notCommandAnswer,
  deniedAnswer,
]

// What starts a shell command inside a longer line: a separator, a subshell, a substitution.
const segmentBreaks = /[;&|\n(){}`<>]|\$\(/

/**
 * Whether a person's `deny` rule (`command(<words>)`, which Antigravity matches against the
 * start of a command) may deny some command of the line. Wide on purpose: any segment of a
 * compound line counts, a rule with a wildcard counts by what comes before it, and a rule that
 * isn't a `command(…)` one is none. A rule of the line "may" deny is refused, not asked.
 */
export const mayDeny = (line: string, rules: readonly string[]): boolean => {
  const segments = line
    .split(segmentBreaks)
    .map((segment) => segment.trim())
    .filter(Boolean)
  for (const rule of rules) {
    const found = /^command\(([\s\S]*)\)$/.exec(rule.trim())
    if (!found) continue
    const pattern = found[1]!.trim()
    const wild = pattern.search(/[*?[\]{}\\]/)
    const literal = (wild < 0 ? pattern : pattern.slice(0, wild)).trimEnd()
    for (const segment of [line.trim(), ...segments]) {
      if (
        wild < 0
          ? segment === pattern || segment.startsWith(`${pattern} `)
          : segment.startsWith(literal)
      )
        return true
    }
  }
  return false
}

/**
 * The `--settings` file's text: the programs it runs unasked, `command(<program>)` each, after
 * the person's own `allow` rules (`kept`, verbatim). Antigravity replaces its user settings'
 * `permissions.allow` with this file's (probed 2026-11-01, 1.4.12: approvals-agy m4, m10) but keeps
 * their `deny` and `ask` when this file names none, so only `allow` is written: the person's
 * denials and questions stay theirs, read live, and their allowances are not lost.
 */
export const launchSettings = (programs: readonly string[], kept: readonly string[] = []): string =>
  `${JSON.stringify({
    permissions: {
      allow: [...new Set([...kept, ...programs.map((program) => `command(${program})`)])],
    },
  })}\n`

/** A program name the launch settings may hold: a bare name, nothing a pattern could widen. */
export const isLaunchProgram = (program: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(program)
