import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { fieldsOf } from "@novadeck/harness-core/fields"

import {
  type Choice,
  choose,
  collapse,
  firstOption,
  labelled,
  optionsAt,
  type Parsed,
  squash,
  type Wording,
  wrapped,
} from "./dialog-screen.js"
import { patchPaths } from "./patch.js"
import { mcpName, mcpTool } from "./tools.js"

/** The key an approval's printed shortcut presses, or undefined for one not understood. */
const keyOf = (hint: string): string | undefined => {
  if (hint === "esc") return "\x1b"
  if (hint === "enter") return "\r"
  if (hint === "space") return " "
  if (hint === "tab") return "\t"
  // Ctrl as Codex has drawn it: `ctrl+`, `^` (0.161.0) and `⌃` (macOS, 0.163.0).
  const control = /^(?:ctrl\+|\^|⌃)([a-z])$/.exec(hint)
  if (control) return String.fromCharCode(control[1]!.charCodeAt(0) - 96)
  return hint.length === 1 && hint >= "!" && hint <= "~" ? hint : undefined
}

const execWordings: readonly Wording[] = [
  { label: /^Yes, proceed$/ },
  { label: /^Yes, and don't ask again for commands that start with `.+`$/ },
  { label: /^Yes, and don't ask again for this command in this session$/ },
  { label: /^Yes, and allow these permissions for this session$/ },
  { label: /^No, continue without running it$/ },
  { label: /^No, and tell Codex what to do differently$/, prompt: true },
]
const patchWordings: readonly Wording[] = [
  { label: /^Yes, proceed$/ },
  { label: /^Yes, and don't ask again for these files$/ },
  { label: /^No, and tell Codex what to do differently$/, prompt: true },
]
const permissionWordings: readonly Wording[] = [
  { label: /^Yes, grant these permissions for this turn$/ },
  { label: /^Yes, grant for this turn with strict auto review$/ },
  { label: /^Yes, grant these permissions for this session$/ },
  { label: /^No, continue without permissions$/ },
]

// Each approval by its title.
const approvals = {
  "Would you like to run the following command?": execWordings,
  "Would you like to make the following edits?": patchWordings,
  "Would you like to grant these permissions?": permissionWordings,
} as const

const slashes = (path: string): string => squash(path).replace(/\\/g, "/")

const sameFile = (destination: string, file: string): boolean => {
  const wanted = slashes(file).replace(/^\.\//, "")
  const shown = destination.replace(/\\/g, "/")
  return shown === wanted || shown.endsWith(`/${wanted}`)
}

/** The lines of the command an exec approval shows, from its `$ ` line to its options. */
const shownCommand = (body: readonly string[]): readonly string[] | undefined => {
  const start = body.findIndex((line) => /^\s*\$ /.test(line))
  if (start < 0) return undefined
  return [body[start]!.replace(/^\s*\$ /, ""), ...body.slice(start + 1)]
}

/** The lines under each `Destination:` of a patch approval, as one path each. */
const shownDestinations = (body: readonly string[]): readonly string[] => {
  const found: string[] = []
  for (const line of body) {
    const start = /^\s*Destination:(.*)$/.exec(line)
    if (start) found.push(squash(start[1]!))
    else if (found.length > 0) found[found.length - 1] += squash(line)
  }
  return found
}

const headers = /^\s*(?:Permission rule|Reason|Environment|Thread|Description|Destination):|^\s*\$ /

/** The lines a header's field takes in an approval's body, from after the header to the next. */
const field = (body: readonly string[], header: string): readonly string[] | undefined => {
  const start = body.findIndex((line) => line.trimStart().startsWith(`${header}:`))
  if (start < 0) return undefined
  const lines = [body[start]!.trimStart().slice(header.length + 1)]
  for (const line of body.slice(start + 1)) {
    if (headers.test(line)) break
    lines.push(line)
  }
  return lines
}

/** A command's, a patch's or extra permissions' approval, each option by its printed shortcut. */
const approval = (lines: readonly string[], facts: RequestFacts): Parsed | undefined => {
  if (facts.kind !== "permission") return undefined
  const title = lines.findLastIndex((line) => line.trim() in approvals)
  if (title < 0) return undefined
  const name = lines[title]!.trim() as keyof typeof approvals
  const first = firstOption(lines, title + 1)
  if (first < 0) return undefined
  const body = lines.slice(title + 1, first)
  const input = fieldsOf(facts.input)
  let detail: string | null = null

  if (name === "Would you like to run the following command?") {
    if (facts.tool !== "Bash" || typeof input?.command !== "string") return undefined
    const shown = shownCommand(body)
    if (!shown || !wrapped(shown, input.command)) return undefined
    // As Codex will run it: its line breaks and characters stay, for the Inbox to show.
    detail = input.command
  } else if (name === "Would you like to make the following edits?") {
    if (facts.tool !== "apply_patch" || typeof input?.command !== "string") return undefined
    const files = patchPaths(input.command)
    const shown = shownDestinations(body)
    if (files.length === 0 || shown.length === 0) return undefined
    if (!shown.every((each) => files.some((file) => sameFile(each, file)))) return undefined
    if (!files.every((file) => shown.some((each) => sameFile(each, file)))) return undefined
    detail = shown.join("\n")
  } else {
    if (facts.tool !== "request_permissions") return undefined
    const reason = typeof input?.reason === "string" ? input.reason.trim() : undefined
    const granted = fieldsOf(input?.permissions)
    const system = granted?.file_system
    // A file-system rule isn't one this reads back to the screen's wording.
    if (system !== undefined && system !== null) return undefined
    const rule = fieldsOf(granted?.network)?.enabled === true ? "network" : undefined
    if (reason === undefined && rule === undefined) return undefined
    const shownReason = field(body, "Reason")
    const shownRule = field(body, "Permission rule")
    if (
      reason === undefined
        ? shownReason !== undefined
        : !shownReason || !wrapped(shownReason, reason)
    )
      return undefined
    if (rule === undefined ? shownRule !== undefined : !shownRule || !wrapped(shownRule, rule))
      return undefined
    detail = [rule && `Permission rule: ${rule}`, reason && `Reason: ${collapse(reason)}`]
      .filter((line) => line !== undefined && line !== "")
      .join("\n")
  }

  const { rows, next } = optionsAt(lines, first)
  const footer = lines[next]
  if (rows.length === 0 || (footer !== undefined && !/^\s*Press /.test(footer))) return undefined
  const wordings = approvals[name]
  const picks: Choice[] = []
  for (const row of rows) {
    const hinted = /^(.*\S) \(([^()]+)\)$/.exec(row.text)
    const label = hinted?.[1] ?? row.text
    const wording = wordings.find(({ label: pattern }) => pattern.test(label))
    if (!wording) return undefined
    const key = hinted ? keyOf(hinted[2]!) : undefined
    // An option whose shortcut isn't printed, or isn't one to press, can't be answered.
    if (key !== undefined) {
      picks.push({ id: String(row.n), label, key, text: wording.prompt ? "prompt" : null })
    }
  }
  if (picks.length === 0 || new Set(picks.map(({ key }) => key)).size !== picks.length)
    return undefined
  return choose(name, picks, detail)
}

const mcpWordings = [
  { label: "Allow", description: "Run the tool and continue" },
  {
    label: "Allow for this session",
    description: "Run the tool and remember this choice for this session",
  },
  {
    label: "Always allow",
    description: "Run the tool and remember this choice for future tool calls",
  },
  { label: "Cancel", description: "Cancel this tool call" },
] as const

/** An MCP tool's approval form, each row by its digit. */
const mcpApproval = (lines: readonly string[], facts: RequestFacts): Parsed | undefined => {
  if (facts.kind !== "permission" || !facts.tool.startsWith("mcp__")) return undefined
  const form = lines.findLastIndex((line) => /^\s*Field \d+\/\d+\s*$/.test(line))
  const message = lines[form + 1]
  const asked =
    message === undefined ? null : /^\s*(Allow .+ to run tool "(.+)"\?)\s*$/.exec(message)
  if (form < 0 || !asked) return undefined
  const server = /^Allow the (.+) MCP server to run tool/.exec(asked[1]!)?.[1]
  const tool = asked[2]!
  // The hooks name the tool with its server's punctuation as underscores; the form, as is.
  if (!facts.tool.endsWith(`__${mcpName(tool)}`)) return undefined
  if (server !== undefined && facts.tool !== mcpTool(server, tool)) return undefined
  const first = firstOption(lines, form + 2)
  if (first < 0) return undefined
  // The arguments the form prints, one `name: value` line each in name order.
  const given = facts.input === null || facts.input === undefined ? {} : fieldsOf(facts.input)
  if (!given) return undefined
  const printed = Object.keys(given)
    .toSorted()
    .map((key) => {
      const value = given[key]
      return `${key}: ${typeof value === "string" ? collapse(value) : JSON.stringify(value)}`
    })
  if (!wrapped(lines.slice(form + 2, first), printed.join(" "))) return undefined
  const { rows } = optionsAt(lines, first)
  const known = rows.map((row) => mcpWordings.find(({ label }) => labelled(row.head, label)))
  if (rows.length < 2 || known.some((each) => each === undefined)) return undefined
  // Each row in the order Codex offers them, ending with the cancel.
  const order = known.map((each) => mcpWordings.indexOf(each!))
  if (order.some((at, i) => i > 0 && at <= order[i - 1]!) || order.at(-1) !== 3 || order[0] !== 0) {
    return undefined
  }
  const described = rows.every((row, i) => row.text.includes(known[i]!.description))
  if (!described || rows.length > 9) return undefined
  const picks = rows.map((row, i) => ({
    id: String(row.n),
    label: known[i]!.label,
    key: String(row.n),
    text: null,
  }))
  return choose(asked[1]!, picks, printed.length > 0 ? printed.join("\n") : null)
}

/** An approval Codex asks of the person: an MCP tool's form, or a command, patch or permissions. */
export const permission = (lines: readonly string[], facts: RequestFacts): Parsed | undefined =>
  mcpApproval(lines, facts) ?? approval(lines, facts)
