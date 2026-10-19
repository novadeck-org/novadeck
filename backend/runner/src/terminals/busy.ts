/**
 * Whether the agent's activity says it works, for the doorbell: no look at its screen then
 * can call its box idle (a spinner draws and a status line says working). A turn running
 * always counts. Background agents a stopped turn left running, and subagents that run on,
 * count only where its harness's box takes no prompt meanwhile
 * (`inBackground` false): where it does, the screen says whether the box is empty. The
 * agents list counts that work as busy either way (activity's `summary`).
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
  inBackground = false,
): boolean =>
  activity !== null &&
  activity !== undefined &&
  (activity.state === "working" ||
    (!inBackground &&
      ((activity.subagents?.length ?? 0) > 0 || (activity.background?.agents ?? 0) > 0)))
