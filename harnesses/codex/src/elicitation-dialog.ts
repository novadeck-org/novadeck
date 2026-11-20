import { cutText } from "@novadeck/harness-core/decode"
import { refuse, type ScreenRequest } from "@novadeck/harness-core/dialogs"
import { agentLimits } from "@novadeck/protocol"

/**
 * An MCP server's elicitation, a form it asks the person to fill, as Codex draws it: no hook
 * tells of it, so the screen alone does (`DialogAdapter.screenRequest`). It comes in two shapes
 * (probed 2026-11-20, 0.170.0, at 120, 80 and 50 columns, fixtures/elicitation.probe.json; their
 * words read in its binary too):
 *
 * - A form whose fields Codex can take as questions (text and choices): `Field 1/2 (2 required
 *   unanswered)`, the server's message, then a field at a time, under a footer from
 *   `enter to submit` to `esc to cancel` (`… answer | ^p / ^n change field | esc to cancel`
 *   with several fields, which wraps onto a second row on a narrow screen). The server is the
 *   one the call above it names (`• Calling probe.form`), where it is a call of the root's: a
 *   spawned agent's form is drawn in its root's screen too, with no call above it to name the
 *   server. Codex's approval of an MCP tool's call is drawn the same, but asks `Allow the … MCP
 *   server to run tool "…"?`, wrapped as the screen's width has it, offers `Allow` and
 *   `Cancel`, and has a hook of its own: it is no elicitation.
 * - A form it can't (a number, a yes/no): `<server> needs your approval.`, `Server: <server>`,
 *   the message, then `Yes, provide the requested info (y)`, `No, but continue without it
 *   (esc)` and `Cancel this request (esc)` over `Press enter to confirm or esc to cancel`.
 *
 * Either goes once answered or cancelled, the call's result taking its place, and the turn
 * runs on. It is a question of the server's, named as Claude Code's Elicitation hook names one
 * (`mcp__<server>__elicitation`), about its message. Novadeck reads no answer from it: the
 * person answers it in the terminal, as the dialog's raw text says.
 */

export type Elicitation = { readonly server: string | null; readonly message: string }

const formHeader = /^\s*Field \d+\/\d+(?: \(\d+ required unanswered\))?$/
const formFooter = /^\s*enter to submit\b/
// An MCP tool's approval, its message joined from the rows it wraps over, which on a narrow
// screen may break inside a name and put its `?` on a row of its own; and its options, which
// no elicitation draws, the first row of each whatever the width (probed 2026-11-20, 0.170.0,
// at 120 down to 40 columns, fixtures/elicitation.probe.json `approvals`).
const toolApproval = /^Allow .+ run tool "/
const approvalOption =
  /^\s*(?:› )?\d+\. (?:Allow {2,}Run the tool\b|Cancel {2,}Cancel this tool call\b)/
// The call that asked, above the form: its server, then its tool.
const calling = /^\s*[•◦] Call(?:ing|ed) ([^\s.]+)\.\S+$/

const approvalTitle = /^\s*(\S.*) needs your approval\.$/
const approvalFooter = /^\s*Press enter to confirm or esc to cancel$/
const approvalOptions = [
  /^\s*(?:› )?1\. Yes, provide the requested info \(y\)$/,
  /^\s*(?:› )?2\. No, but continue without it \(esc\)$/,
  /^\s*(?:› )?3\. Cancel this request \(esc\)$/,
]

// The rows from `from` on up to the first blank one, joined: a text the screen wrapped.
const paragraph = (rows: readonly string[], from: number): string => {
  const words: string[] = []
  for (let at = from; at < rows.length && rows[at]!.trim() !== ""; at += 1)
    words.push(rows[at]!.trim())
  return words.join(" ")
}

// The form shape: its footer the screen's last rows, its header above them.
const form = (rows: readonly string[], last: number): Elicitation | undefined => {
  const start = formFooter.test(rows[last]!) ? last : last - 1
  if (start < 0 || !formFooter.test(rows[start]!)) return refuse("elicitation.form.1")
  const footer = rows
    .slice(start, last + 1)
    .map((row) => row.trim())
    .join(" ")
  if (!/\besc to cancel$/.test(footer)) return refuse("elicitation.form.2")
  const header = rows.slice(0, start).findLastIndex((row) => formHeader.test(row))
  if (header < 0) return refuse("elicitation.form.3")
  const message = paragraph(rows, header + 1)
  if (!message) return refuse("elicitation.form.4")
  if (
    toolApproval.test(message) ||
    rows.slice(header, start).some((row) => approvalOption.test(row))
  )
    return refuse("elicitation.form.5")
  const called = rows
    .slice(0, header)
    .findLast((row) => calling.test(row))
    ?.match(calling)?.[1]
  return { server: called ?? null, message }
}

// The approval shape: title, server, message, its three options, and its footer last.
const approval = (rows: readonly string[], last: number): Elicitation | undefined => {
  if (!approvalFooter.test(rows[last]!)) return refuse("elicitation.approval.1")
  const title = rows.slice(0, last).findLastIndex((row) => approvalTitle.test(row))
  if (title < 0) return refuse("elicitation.approval.2")
  const server = approvalTitle.exec(rows[title]!)![1]!
  const body = rows.slice(title + 1, last).filter((row) => row.trim() !== "")
  if (body[0]?.trim() !== `Server: ${server}`) return refuse("elicitation.approval.3")
  const options = body.slice(-approvalOptions.length)
  if (!approvalOptions.every((option, at) => option.test(options[at] ?? "")))
    return refuse("elicitation.approval.4")
  const named = rows.findIndex((row, at) => at > title && row.trim() === `Server: ${server}`)
  const from = rows.findIndex((row, at) => at > named && row.trim() !== "")
  const message = paragraph(rows, from)
  if (!message || approvalOptions.some((option) => option.test(message)))
    return refuse("elicitation.approval.5")
  return { server, message }
}

/** The MCP elicitation Codex's screen shows at its bottom, in either shape, or undefined. */
export const elicitation = (screen: readonly string[]): Elicitation | undefined => {
  const rows = screen.map((row) => row.trimEnd())
  const last = rows.findLastIndex((row) => row !== "")
  if (last < 0) return refuse("elicitation.elicitation.1")
  return form(rows, last) ?? approval(rows, last) ?? refuse("elicitation.elicitation.2")
}

/** The tool an elicitation's request goes by, as Claude Code's Elicitation hook names one. */
export const elicitationTool = (server: string | null): string =>
  server === null ? "mcp__elicitation" : `mcp__${server}__elicitation`

/** An elicitation on screen as the request it is: the server's question, about its message. */
export const elicitationRequest = ({ server, message }: Elicitation): ScreenRequest => ({
  kind: "question",
  tool: elicitationTool(server),
  input: { mcp_server_name: server, message },
  subject: cutText(message, agentLimits.subject),
})
