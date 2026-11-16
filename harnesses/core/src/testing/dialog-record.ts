import type { DialogAdapter, DialogRead, RequestFacts } from "../dialogs.js"
import { explain } from "../dialogs.js"
import { screenOf, screenRecord, type ScreenRecord } from "./probes.js"

/**
 * A dialog the runner could not read, as the person saves it with "Save for debugging": one
 * JSON file that holds the screen and what the request asked, shaped to be replayed. Its
 * `scenario` is the shape of a probe fixture's scenario (`events`, `screens` by
 * `<columns>x<rows>`), so a developer can paste it under a name into
 * `harnesses/<harness>/src/fixtures/*.probe.json`; `request` is the request's facts as the
 * adapter was given them, which `readRecord` replays without any fixture.
 *
 * It holds the screen's text and the tool's input, which a log never does: it is written
 * only on the person's own action (see SECURITY.md).
 */
export type DialogRecord = {
  readonly format: "novadeck.dialog.v1"
  readonly harness: string
  readonly version: string | null
  readonly savedAt: string
  /** Why the dialog is raw: unrecognized, unsupported, clash or failed. */
  readonly reason: string
  /** The adapter's refusal codes for the screen, in the order they were noted (`explain`). */
  readonly refusals: readonly string[]
  readonly columns: number
  readonly rows: number
  readonly request: Pick<RequestFacts, "kind" | "tool" | "input" | "cwd">
  readonly scenario: {
    readonly version?: string
    readonly events: readonly {
      readonly event: "PermissionRequest" | "Elicitation"
      readonly payload: unknown
    }[]
    readonly screens: { readonly [size: string]: ScreenRecord }
  }
}

export type DialogRecordInput = {
  readonly harness: string
  readonly version: string | null
  readonly now: Date
  readonly reason: string
  readonly refusals: readonly string[]
  readonly request: RequestFacts
  readonly rows: readonly string[]
  readonly columns: number
}

/** The record to save of a request's dialog and the screen it was not read from. */
export const dialogRecord = (given: DialogRecordInput): DialogRecord => {
  const { request, columns } = given
  const size = `${columns}x${given.rows.length}`
  // An MCP form is Claude Code's Elicitation hook, whose payload is the input; the rest ask
  // as a PermissionRequest, as the probe fixtures keep them.
  const elicitation = request.tool.startsWith("mcp__") && request.tool.endsWith("__elicitation")
  return {
    format: "novadeck.dialog.v1",
    harness: given.harness,
    version: given.version,
    savedAt: given.now.toISOString(),
    reason: given.reason,
    refusals: given.refusals,
    columns,
    rows: given.rows.length,
    request: { kind: request.kind, tool: request.tool, input: request.input, cwd: request.cwd },
    scenario: {
      ...(given.version !== null && { version: given.version }),
      events: [
        elicitation
          ? { event: "Elicitation", payload: request.input }
          : {
              event: "PermissionRequest",
              payload: { tool_name: request.tool, tool_input: request.input },
            },
      ],
      screens: { [size]: screenRecord(given.rows.join("\n"), { columns }) },
    },
  }
}

/** The rows of the screen a record holds. */
export const rowsOfRecord = (record: DialogRecord): string[] => {
  const [shown] = Object.values(record.scenario.screens)
  if (!shown) throw new Error("the record holds no screen")
  const rows = [...screenOf(shown).rows]
  while (rows.length < record.rows) rows.push("")
  return rows
}

/** The record's request and screen given to `adapter`, as the runner gave them, with the refusals it noted. */
export const readRecord = (
  adapter: DialogAdapter,
  record: DialogRecord,
): { read: DialogRead | undefined; refusals: string[] } => {
  const { result, refusals } = explain(() =>
    adapter.read(rowsOfRecord(record), { ...record.request }),
  )
  return { read: result, refusals }
}
