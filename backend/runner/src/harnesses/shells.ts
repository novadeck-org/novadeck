import { agentLimits, type AgentActivity } from "@novadeck/protocol"

/**
 * The background shells an agent started, as the activity keeps them (see
 * `AgentActivity.shells`): each by the id its harness names it by, from when it started
 * until its harness says it ended, and then, with its exit code, among the last few that
 * did, so a client can show how the latest ended.
 */
export type Shell = {
  readonly id: string
  readonly command: string
  readonly since: number
  readonly exit: { readonly at: number; readonly code: number | null } | null
}

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
): readonly Shell[] =>
  shells.some((shell) => shell.id === id)
    ? shells
    : kept([...shells, { id, command: command.slice(0, agentLimits.command), since, exit: null }])

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
        shells: shells.map(({ id, command, since, exit }) => ({
          id,
          command,
          since,
          exit: exit && { at: exit.at, code: exit.code },
        })),
      }
