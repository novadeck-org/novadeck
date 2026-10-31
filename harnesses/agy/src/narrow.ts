// Antigravity in a narrowed terminal: one started or resumed while the person's grant covers
// it, with `--settings` allowing the granted programs and NOVADECK_NARROW=1 in its env (see
// approvals-design.md, Appendix B). Its PreToolUse then decides every call, and a hook that
// prints nothing, or fails, lets a granted program run unasked, so every answer path prints
// one of these three lines, and "closed" is the one for anything else.

/** Runs a call of a granted program with no dialog; fails any other call. */
export const runAnswer = '{"decision":"deny_unless_prior_grant"}'

/** Puts the "Run this command?" dialog back, over every other handler's answer. */
export const closedAnswer = '{"decision":"force_ask"}'

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
export const narrowedAnswers: readonly string[] = [runAnswer, closedAnswer, notCommandAnswer]

/** The `--settings` file's text: the programs it runs unasked, `command(<program>)` each. */
export const launchSettings = (programs: readonly string[]): string =>
  `${JSON.stringify({ permissions: { allow: programs.map((program) => `command(${program})`) } })}\n`

/** A program name the launch settings may hold: a bare name, nothing a pattern could widen. */
export const isLaunchProgram = (program: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(program)
