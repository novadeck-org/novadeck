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

// Words a command may begin with that are not the program: shell keywords, and programs that run
// the one after them. Antigravity sees through some (env, time, nohup, an assignment) and not
// others (sudo, xargs, command: probed, approvals-agy n11-n22); here all are, which is wider.
const keywords = new Set(["if", "then", "do", "else", "elif", "while", "until", "!", "{", "("])
const wrappers = new Set(["sudo", "env", "xargs", "exec", "time", "nohup", "command", "builtin"])
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/

// The words a segment's program may start at: after keywords, assignments and wrappers (with
// their options), and for a wrapper at each of the next few words, as an option may take one.
const startsOf = (words: readonly string[]): number[] => {
  const starts: number[] = []
  let at = 0
  let wrapped = false
  while (at < words.length) {
    const word = words[at]!
    if (assignment.test(word) || keywords.has(word)) at += 1
    else if (wrappers.has(word)) {
      wrapped = true
      at += 1
      while (at < words.length && (words[at]!.startsWith("-") || assignment.test(words[at]!)))
        at += 1
    } else break
  }
  for (let each = at; each < Math.min(words.length, at + (wrapped ? 4 : 1)); each += 1)
    starts.push(each)
  return starts
}

const unquoted = (word: string): string => word.replace(/^["']+|["']+$/g, "")
const basename = (word: string): string => unquoted(word).split(/[\\/]/).pop() ?? word

/**
 * Whether a person's `deny` rule (`command(<words>)`) may deny some command of the line.
 * Probed on 1.4.12 (approvals-agy n-cases): a rule is the literal words a command starts
 * with, case-sensitive, spaces and tabs alike; `command(*)` alone matches every command, and any
 * other glob, or an empty rule, matches nothing. Agy finds a command after `&&`, `;`, `if`,
 * a subshell, `env`, `time`, `nohup` and an assignment. This is at least that wide: every segment
 * of a compound line counts, keywords and wrapper programs are skipped, quotes and a program's
 * folder are ignored, and on Windows the program is compared without regard to case. A rule that
 * isn't a `command(…)` one is none. A line it "may" deny is refused, not asked.
 */
export const mayDeny = (line: string, rules: readonly string[], windows = false): boolean => {
  const patterns: string[] = []
  for (const rule of rules) {
    const found = /^command\(([\s\S]*)\)$/.exec(rule.trim())
    if (found) patterns.push(found[1]!.trim().replace(/\s+/g, " "))
  }
  if (patterns.includes("*")) return true
  const fold = (text: string) => (windows ? text.toLowerCase() : text)
  const wanted = patterns.filter((pattern) => pattern !== "").map(fold)
  if (wanted.length === 0) return false
  const matches = (candidate: string) =>
    wanted.some((pattern) => candidate === pattern || candidate.startsWith(`${pattern} `))
  const segments = [line, ...line.split(segmentBreaks)]
    .map((segment) => segment.trim().replace(/\s+/g, " "))
    .filter(Boolean)
  for (const segment of segments) {
    const words = segment.split(" ")
    for (const start of startsOf(words)) {
      const rest = words.slice(start + 1)
      const program = words[start]!
      // As written, with the program's quotes off, and with its folder off.
      for (const name of [program, unquoted(program), basename(program)])
        if (matches(fold([name, ...rest].join(" ")))) return true
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
