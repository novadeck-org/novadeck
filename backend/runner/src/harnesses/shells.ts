import { agentLimits, type AgentActivity } from "@novadeck/protocol"

/**
 * The background shells an agent started, as the activity keeps them (see
 * `AgentActivity.shells`): each by the id its harness names it by, from when it started
 * until its harness says it ended, and then, with its exit code, among the last few that
 * did, so a client can show how the latest ended. `output` is the file its output is in
 * while it runs, where its harness or Novadeck's capture knows one.
 */
export type Shell = {
  readonly id: string
  readonly command: string
  readonly since: number
  readonly exit: { readonly at: number; readonly code: number | null } | null
  readonly output?: string
}

/** A shell's output file told before the shell was, held until it is. */
export type Output = { readonly id: string; readonly path: string }

// How many ended shells are kept beside those running.
const endedKept = 4

// The shells kept: all that run (the newest `agentLimits.shells` of them) and the ended ones
// that ended last, in the order they started.
const kept = (shells: readonly Shell[]): readonly Shell[] => {
  const ended = shells
    .filter(({ exit }) => exit)
    .toSorted((a, b) => b.exit!.at - a.exit!.at)
    .slice(0, endedKept)
  const running = shells.filter(({ exit }) => !exit).slice(-(agentLimits.shells - ended.length))
  const keep = new Set([...ended, ...running])
  return shells.filter((shell) => keep.has(shell))
}

/** The shells with one more that started at `since`; unchanged where its id is known. */
export const shellStarted = (
  shells: readonly Shell[],
  id: string,
  command: string,
  since: number,
  output?: string,
): readonly Shell[] =>
  shells.some((shell) => shell.id === id)
    ? shells
    : kept([
        ...shells,
        {
          id,
          command: command.slice(0, agentLimits.command),
          since,
          exit: null,
          ...(output !== undefined && { output }),
        },
      ])

/**
 * The shells with `id`'s output in `path`, else, where no shell has that id yet, the held
 * outputs with this one: the newest `agentLimits.shells`, one to an id, for `shellStarted`
 * to take when the shell comes. Both unchanged where nothing is new.
 */
export const shellOutput = (
  shells: readonly Shell[],
  held: readonly Output[],
  id: string,
  path: string,
): { readonly shells: readonly Shell[]; readonly held: readonly Output[] } => {
  // A path the protocol would refuse is no output.
  if (path.length > agentLimits.path) return { shells, held }
  const shell = shells.find((each) => each.id === id)
  if (shell)
    return shell.output === path
      ? { shells, held }
      : { shells: shells.map((each) => (each === shell ? { ...each, output: path } : each)), held }
  if (held.some((each) => each.id === id && each.path === path)) return { shells, held }
  return {
    shells,
    held: [...held.filter((each) => each.id !== id), { id, path }].slice(-agentLimits.shells),
  }
}

/** The shells with `id` ended at `at`; unchanged where it is not known or ended already. */
export const shellEnded = (
  shells: readonly Shell[],
  id: string,
  code: number | null,
  at: number,
): readonly Shell[] =>
  shells.some((shell) => shell.id === id && !shell.exit)
    ? kept(shells.map((shell) => (shell.id === id ? { ...shell, exit: { at, code } } : shell)))
    : shells

/**
 * The shells with those that started before `at` and are not among the `running` ids ended
 * at `at`, with no code.
 */
export const shellsListed = (
  shells: readonly Shell[],
  running: readonly string[],
  at: number,
): readonly Shell[] =>
  shells.some((shell) => !shell.exit && shell.since < at && !running.includes(shell.id))
    ? kept(
        shells.map((shell) =>
          !shell.exit && shell.since < at && !running.includes(shell.id)
            ? { ...shell, exit: { at, code: null } }
            : shell,
        ),
      )
    : shells

/** The shells as clients see them; absent where there are none. */
export const shellsOf = (shells: readonly Shell[]): Pick<AgentActivity, "shells"> =>
  shells.length === 0
    ? {}
    : {
        shells: shells.map(({ id, command, since, exit, output }) => ({
          id,
          command,
          since,
          exit: exit && { at: exit.at, code: exit.code },
          ...(output !== undefined && { output }),
        })),
      }
