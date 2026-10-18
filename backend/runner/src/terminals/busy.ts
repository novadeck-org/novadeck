/**
 * Whether the agent's activity says a turn runs or subagents do, which wake it: no look at
 * its screen then can call its box idle (a spinner draws and a status line says working).
 */
export const busy = (
  activity:
    | {
        readonly state: string
        readonly subagents?: readonly unknown[]
        readonly background: { readonly agents: number; readonly tasks: number } | null
      }
    | null
    | undefined,
): boolean =>
  activity !== null &&
  activity !== undefined &&
  (activity.state === "working" ||
    (activity.subagents?.length ?? 0) > 0 ||
    (activity.background?.agents ?? 0) > 0)
