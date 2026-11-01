// Codex's rollout, read for one exec call: its permission hook carries the command alone, but the
// rollout records the call's arguments (its `workdir`, a `shell` to launch, extra permissions) and
// its turn's folder and mode before any hook of the call runs (probed, 0.165.0 and 0.166.0).

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
  /** The folder the turn runs in (its `turn_context`'s `cwd`), which a relative `workdir` is taken against. */
  readonly cwd: string | undefined
}

// The arguments of an `exec_command` that change nothing about what the hook was asked: the
// command, where it runs, how long to wait and how much to read back, and that it asks to run
// outside the sandbox (the permission request this is). Anything else (`shell`, `login`,
// `additional_permissions`, `prefix_rule`, a key unknown to this list) may make the call more
// than its `cmd`, so no grant covers it.
const safeArguments = (args: Record<string, unknown>): boolean =>
  Object.entries(args).every(([key, value]) => {
    switch (key) {
      case "cmd":
        return typeof value === "string"
      case "workdir":
        return value === null || typeof value === "string"
      case "sandbox_permissions":
        return value === "use_default" || value === "require_escalated"
      case "justification":
        return value === null || typeof value === "string"
      case "yield_time_ms":
      case "max_output_tokens":
        return value === null || typeof value === "number"
      case "tty":
        // A tty session stays open for `write_stdin`, which types into the escalated process
        // (an editor a granted command opens, then a shell escape) with no request of its own.
        return value === false
      default:
        return false
    }
  })

/**
 * What the rollout's `text` says of the `exec_command` call of `turn` whose `cmd` is `command`.
 * - `workdir`: that of the one such call with no output yet, which must also be the turn's last
 *   `exec_command` on disk (the call being asked about is the newest). Undefined where there is
 *   none, more than one, an older call is the pending one, the `workdir` isn't text, or the call
 *   holds an argument outside `safeArguments`.
 * - `cwd`: the turn's folder, from its `turn_context`.
 * - `planning`: the turn's `task_started` (`collaboration_mode_kind`) and `turn_context`
 *   (`collaboration_mode.mode`) name its mode: planning if either says `plan`, not planning if
 *   one says another mode, undefined if neither is on disk.
 * Lines that aren't whole (the cut start of a tail) are skipped.
 */
export const rolloutCall = (text: string, turn: string, command: string): RolloutCall => {
  const pending = new Map<string, Record<string, unknown>>()
  const others = new Set<string>()
  let cwd: string | undefined
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
      if (payload["turn_id"] === turn && typeof payload["cwd"] === "string") cwd = payload["cwd"]
      continue
    }
    if (item?.["type"] !== "response_item") continue
    const id = payload["call_id"]
    if (typeof id !== "string") continue
    if (payload["type"] === "function_call_output") done.add(id)
    if (payload["type"] !== "function_call") continue
    if (record(payload["internal_chat_message_metadata_passthrough"])?.["turn_id"] !== turn)
      continue
    // Every tool call of the turn counts as the newest, not only the `exec_command` ones.
    last = id
    let args: Record<string, unknown> | undefined
    try {
      args = record(JSON.parse(String(payload["arguments"])))
    } catch {
      continue
    }
    if (payload["name"] === "exec_command") {
      if (args?.["cmd"] === command) pending.set(id, args)
    } else if (Object.values(args ?? {}).includes(command)) {
      // Another tool (`shell_command`…) asked for the same text: which one is being asked about
      // can't be told.
      others.add(id)
    }
  }
  const planning = modes.length === 0 ? undefined : modes.includes(true)
  const open = [...pending].filter(([id]) => !done.has(id))
  const unknown = { workdir: undefined, planning, cwd }
  if (open.length !== 1 || [...others].some((id) => !done.has(id))) return unknown
  const [id, args] = open[0] as [string, Record<string, unknown>]
  if (id !== last || !safeArguments(args)) return unknown
  const workdir = args["workdir"]
  return {
    workdir:
      workdir === undefined || workdir === null || workdir === "" ? null : (workdir as string),
    planning,
    cwd,
  }
}
