// Codex's rollout, read for the folder of one exec call: its permission hook names the session's
// folder but not the call's `workdir`, which the rollout records with the call's arguments
// before any hook of the call runs (probed, 0.165.0).

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** What Codex's rollout says of one exec call: where it runs, and whether its turn is planning. */
export type RolloutCall = {
  /** The call's `workdir` as written, null where it names none; undefined where it can't be told. */
  readonly workdir: string | null | undefined
  /** Whether the turn is in Plan Mode; undefined where the rollout doesn't say. */
  readonly planning: boolean | undefined
}

/**
 * What the rollout's `text` says of the `exec_command` call of `turn` whose `cmd` is `command`.
 * - `workdir`: that of the one such call with no output yet, which must also be the turn's last
 *   `exec_command` on disk (the call being asked about is the newest). Undefined where there is
 *   none, more than one, an older call is the pending one, or the `workdir` isn't text.
 * - `planning`: the turn's `task_started` (`collaboration_mode_kind`) and `turn_context`
 *   (`collaboration_mode.mode`) name its mode: planning if either says `plan`, not planning if
 *   one says another mode, undefined if neither is on disk.
 * Lines that aren't whole (the cut start of a tail) are skipped.
 */
export const rolloutCall = (text: string, turn: string, command: string): RolloutCall => {
  const pending = new Map<string, unknown>()
  const done = new Set<string>()
  const modes: boolean[] = []
  let last: string | undefined
  for (const line of text.split("\n")) {
    const calls = line.includes("function_call")
    if (!calls && !line.includes("task_started") && !line.includes("turn_context")) continue
    let item: Record<string, unknown> | undefined
    try {
      item = record(JSON.parse(line))
    } catch {
      continue
    }
    const payload = record(item?.["payload"])
    if (payload === undefined) continue
    if (item?.["type"] === "event_msg" && payload["type"] === "task_started") {
      if (payload["turn_id"] === turn && typeof payload["collaboration_mode_kind"] === "string")
        modes.push(payload["collaboration_mode_kind"] === "plan")
      continue
    }
    if (item?.["type"] === "turn_context") {
      const mode = record(payload["collaboration_mode"])?.["mode"]
      if (payload["turn_id"] === turn && typeof mode === "string") modes.push(mode === "plan")
      continue
    }
    if (item?.["type"] !== "response_item") continue
    const id = payload["call_id"]
    if (typeof id !== "string") continue
    if (payload["type"] === "function_call_output") done.add(id)
    if (payload["type"] !== "function_call" || payload["name"] !== "exec_command") continue
    if (record(payload["internal_chat_message_metadata_passthrough"])?.["turn_id"] !== turn)
      continue
    last = id
    let args: Record<string, unknown> | undefined
    try {
      args = record(JSON.parse(String(payload["arguments"])))
    } catch {
      continue
    }
    if (args?.["cmd"] === command) pending.set(id, args["workdir"] ?? null)
  }
  const planning = modes.length === 0 ? undefined : modes.includes(true)
  const open = [...pending].filter(([id]) => !done.has(id))
  if (open.length !== 1) return { workdir: undefined, planning }
  const [id, workdir] = open[0] as [string, unknown]
  if (id !== last) return { workdir: undefined, planning }
  if (workdir === null || workdir === "") return { workdir: null, planning }
  return { workdir: typeof workdir === "string" ? workdir : undefined, planning }
}
