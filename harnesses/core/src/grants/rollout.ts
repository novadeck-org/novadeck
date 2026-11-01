// Codex's rollout, read for the folder of one exec call: its permission hook names the session's
// folder but not the call's `workdir`, which the rollout records with the call's arguments
// before any hook of the call runs (probed, 0.165.0).

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/**
 * The `workdir` of the one `exec_command` call of `turn` whose `cmd` is `command` and that has
 * no output yet, from the rollout's `text`: the folder as the model wrote it, null where the
 * call names none (it runs in the session's folder). Undefined where it can't be told: no such
 * call on disk yet, more than one, or a `workdir` that isn't text. Lines that aren't whole
 * (the cut start of a tail) are skipped.
 */
export const rolloutWorkdir = (
  text: string,
  turn: string,
  command: string,
): string | null | undefined => {
  const pending = new Map<string, unknown>()
  const done = new Set<string>()
  for (const line of text.split("\n")) {
    if (!line.includes("function_call")) continue
    let item: Record<string, unknown> | undefined
    try {
      item = record(JSON.parse(line))
    } catch {
      continue
    }
    const payload = record(item?.["payload"])
    if (item?.["type"] !== "response_item" || payload === undefined) continue
    const id = payload["call_id"]
    if (typeof id !== "string") continue
    if (payload["type"] === "function_call_output") done.add(id)
    if (payload["type"] !== "function_call" || payload["name"] !== "exec_command") continue
    if (record(payload["internal_chat_message_metadata_passthrough"])?.["turn_id"] !== turn)
      continue
    let args: Record<string, unknown> | undefined
    try {
      args = record(JSON.parse(String(payload["arguments"])))
    } catch {
      continue
    }
    if (args?.["cmd"] === command) pending.set(id, args["workdir"] ?? null)
  }
  const open = [...pending].filter(([id]) => !done.has(id))
  if (open.length !== 1) return undefined
  const workdir = (open[0] as [string, unknown])[1]
  if (workdir === null || workdir === "") return null
  return typeof workdir === "string" ? workdir : undefined
}
