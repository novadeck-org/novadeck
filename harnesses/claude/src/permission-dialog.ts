import { posix, win32 } from "node:path"

import { refuse } from "@novadeck/harness-core/dialogs"
import type { DialogRead, RequestFacts } from "@novadeck/harness-core/dialogs"
import { fieldsOf } from "@novadeck/harness-core/fields"

import {
  choices,
  dashed,
  digitKeys,
  idle,
  nonBlank,
  numbered,
  quoted,
  rule,
  ruled,
  wraps,
  wrapsEnd,
} from "./dialog-screen.js"
import { diffIs } from "./diffs.js"

/**
 * Claude Code's permission dialog: "Do you want to …?" over what the tool would do (a
 * command, a fetch, a read, a file's diff, an MCP tool's arguments) and its numbered
 * options, a digit answering at once whatever the highlight. Their count varies with the
 * width (an MCP tool's second option goes at 60 columns), so the digits come from the screen.
 */

// The row each permission's dialog asks its question on.
const permissionTitle = /^ (Do you want to .+\?)$/
const permissionOption = /^ (❯| ) (\d+)\. (.+)$/
const permissionContinuation = /^ {6,}\S/
// While background agents run (a subagent's own request is one) the footer adds how to stop
// them (` · ctrl+x ctrl+k twice to stop background agents`, 2.1.329, 2026-11-22 tour run).
const permissionFooter =
  /^ Esc to cancel · Tab to amend(?: · ctrl\+x ctrl\+k twice to stop background agents)?$/
// From 2.1.328 a dialog taller than the screen says under its options how many of its rows
// scrolled away above them (` ↑ 145 more lines`, fixtures/tall.probe.json); what shows of it is
// read as before.
const scrolledAway = /^ ↑ [\d,]+ more lines? *$/

// A row of the command a Bash dialog quotes.
const quoteRow = /^ ?│(?: |$)/

// The folder Claude Code runs in, where the request tells it.
const cwdOf = ({ cwd }: RequestFacts): string | null => (cwd ? cwd.replaceAll("\\", "/") : null)

// A path with a drive letter is Windows', resolved and compared as Windows does (either
// slash, any case), whatever the runner's own platform; any other as POSIX.
const windows = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value)
const comparable = (value: string): string =>
  win32.normalize(value).replaceAll("\\", "/").toLowerCase()

/**
 * Whether the file the dialog names is the request's: a shown path is relative to the
 * folder Claude Code runs in, so with that known the full paths must be the same; without
 * it, the request's path must end with the shown one at a folder boundary.
 */
const samePath = (path: string, shown: string, cwd: string | null): boolean => {
  if (windows(path) || windows(shown) || (cwd !== null && windows(cwd))) {
    if (windows(shown)) return comparable(path) === comparable(shown)
    if (cwd !== null) return comparable(path) === comparable(win32.resolve(cwd, shown))
    return comparable(path).endsWith(`/${comparable(shown)}`)
  }
  if (shown.startsWith("/")) return posix.normalize(path) === posix.normalize(shown)
  if (cwd !== null) return posix.normalize(path) === posix.resolve(cwd, shown)
  return path === shown || path.endsWith(`/${shown}`)
}

// A subagent's request says whose it is after its header's label (`Bash command · from the
// general-purpose agent`, and the same on `Create file`, `Read file` and `Fetch`: 2.1.329,
// 2026-11-23 probes; `Tool use` by the same rule, not yet seen). A header is compared by its
// label alone: what the dialog asks is read from its body, whoever asks.
const whose = / · from the \S.* agent$/
const labelOf = (row: string): string => row.replace(whose, "")

// An MCP server's or tool's name as the dialog's title and the tool's own name compare:
// letters and digits, in lower case.
const nameKey = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "")

/**
 * What the dialog shows of what it asks, when that is the request's tool and input in
 * full: its text, as `detail`; undefined where the screen and the request differ at all.
 * A tool this doesn't know is never read.
 */
const shows = (rows: readonly string[], title: number, facts: RequestFacts): string | undefined => {
  const input = fieldsOf(facts.input)
  if (!input) return refuse("permission.shows.1")
  // The three rows above a block, where its header is: each as its label, without whose
  // request it is.
  const header = (open: number): string[] =>
    rows.slice(Math.max(0, open - 3), open).map((each) => labelOf(each.trim()))
  switch (facts.tool) {
    case "Bash": {
      const command = nonBlank(input.command)
      if (!command) return refuse("permission.shows.2")
      const shown = ruled(rows, title)
      // Taller than the screen: its header and first rule have scrolled away, so every row
      // above its closing rule is its own, and they end as the request's command does.
      if (!shown) {
        const close = rows.slice(0, title).findLastIndex((each) => dashed.test(each))
        const body = rows.slice(dashed.test(rows[0] ?? "") ? 1 : 0, Math.max(0, close))
        return body.every((each) => each === "" || quoteRow.test(each)) &&
          wrapsEnd(quoted(body), command)
          ? command
          : refuse("permission.shows.3")
      }
      // Its header is on screen unless the command only just fits.
      const cutHeader = shown.open < 3 && !rows.slice(0, shown.open).some((row) => rule.test(row))
      if (!cutHeader && !header(shown.open).includes("Bash command"))
        return refuse("permission.shows.4")
      // Nothing but the command between its rules; the detail is the request's own command,
      // as it will run, not the screen's wrapped rows.
      return wraps(quoted(shown.body), command) ? command : refuse("permission.shows.5")
    }
    case "WebFetch": {
      const url = nonBlank(input.url)
      const shown = ruled(rows, title)
      if (!url || !shown || !header(shown.open).includes("Fetch"))
        return refuse("permission.shows.6")
      const prompt = nonBlank(input.prompt)
      const expected = `url: ${url}${prompt ? ` prompt: ${prompt}` : ""}`
      return wraps(quoted(shown.body), expected)
        ? quoted(shown.body).join("\n")
        : refuse("permission.shows.7")
    }
    case "Read": {
      // `Read(<path>)` between rules, under a "Read file" header.
      const path = nonBlank(input.file_path)
      const shown = ruled(rows, title)
      if (!path || Object.keys(input).length !== 1 || !shown) return refuse("permission.shows.8")
      if (!header(shown.open).includes("Read file")) return refuse("permission.shows.9")
      const body = quoted(shown.body)
      return wraps(body, `Read(${path})`) ? body.join("\n") : refuse("permission.shows.10")
    }
    case "Write":
    case "Edit": {
      const path = nonBlank(input.file_path)?.replaceAll("\\", "/")
      const close = rows.slice(0, title).findLastIndex((each) => dashed.test(each))
      if (!path || close < 1) return refuse("permission.shows.11")
      // A screen cannot show that every occurrence changed, only that one did.
      if (input.replace_all === true) return refuse("permission.shows.12")
      const open = rows.slice(0, close).findLastIndex((each) => dashed.test(each))
      // The block's top, its header and its subtitle (the file, as Claude Code writes it
      // relative to its folder), must be on screen: a tall diff scrolls them away, and the
      // question names only the file's own name.
      if (open < 2) return refuse("permission.shows.13")
      const asked = /^Do you want to (create|overwrite|make this edit to) (.+)\?$/.exec(
        rows[title]!.trim(),
      )
      if (!asked) return refuse("permission.shows.14")
      const named = rows[open - 1]!.trim().replaceAll("\\", "/")
      const over = asked[1] === "overwrite"
      // The header and the question's verb agree with the tool, the question names the
      // subtitle's file, and the subtitle resolves to the request's.
      const label = labelOf(rows[open - 2]?.trim() ?? "")
      const expected = facts.tool === "Edit" ? "Edit file" : over ? "Overwrite file" : "Create file"
      if (label !== expected || (facts.tool === "Edit") !== (asked[1] === "make this edit to")) {
        return refuse("permission.shows.15")
      }
      if (named === "" || asked[2]!.replaceAll("\\", "/") !== named.split("/").pop())
        return refuse("permission.shows.16")
      if (!samePath(path, named, cwdOf(facts))) return refuse("permission.shows.17")
      const diff = rows.slice(open + 1, close)
      if (!diffIs(diff, facts.tool, over, input, rows[close]!.length))
        return refuse("permission.shows.18")
      return [named, ...quoted(diff)].join("\n")
    }
    default: {
      const mcp = /^mcp__(.+)__([^_].*)$/.exec(facts.tool)
      if (!mcp) return refuse("permission.shows.19")
      const at = rows.findIndex((each, index) => index < title && each.endsWith("(MCP)"))
      const named = /^ (.+?) — (.+?) Tool: \(MCP\)$/.exec(rows[at] ?? "")
      if (!named || at < 1 || labelOf(rows[at - 1]!.trim()) !== "Tool use")
        return refuse("permission.shows.20")
      if (nameKey(named[1]!) !== nameKey(mcp[1]!) || nameKey(named[2]!) !== nameKey(mcp[2]!)) {
        return refuse("permission.shows.21")
      }
      // The arguments, one `name: value` row each, between ╌ rules; none, no rules.
      const entries = Object.entries(input).map(
        ([key, value]) => `${key}: ${JSON.stringify(value)}`,
      )
      const after = rows.slice(at + 1, title)
      const open = after.findIndex((each) => dashed.test(each))
      if (entries.length === 0) {
        return open < 0 && !after.some((each) => dashed.test(each))
          ? ""
          : refuse("permission.shows.22")
      }
      if (open !== 0) return refuse("permission.shows.23")
      const close = after.findIndex((each, index) => index > 0 && dashed.test(each))
      if (close < 0) return refuse("permission.shows.24")
      const args = quoted(after.slice(1, close))
      return wraps(args, entries.join(" ")) ? args.join("\n") : refuse("permission.shows.25")
    }
  }
}

const telling = (label: string): boolean => label.startsWith("No, and tell Claude")

export const permission = (
  rows: readonly string[],
  facts: RequestFacts,
): DialogRead | undefined => {
  if (facts.kind !== "permission") return refuse("permission.permission.1")
  const at = rows.findLastIndex((each) => permissionTitle.test(each))
  if (at < 0) return refuse("permission.permission.2")
  const read = numbered(rows, at + 1, permissionOption, permissionContinuation)
  if (!read) return refuse("permission.permission.3")
  const rest = scrolledAway.test(read.rest[0] ?? "") ? read.rest.slice(1) : read.rest
  if (rest.length > 1 || (rest.length === 1 && !permissionFooter.test(rest[0]!))) {
    return refuse("permission.permission.4")
  }
  const detail = shows(rows, at, facts)
  if (detail === undefined) return refuse("permission.permission.5")
  const title = permissionTitle.exec(rows[at]!)![1]!
  // "No" interrupts the turn and Claude Code asks "What should Claude do instead?": the
  // person's next prompt is the answer (probed 2.1.287 and 2.1.291). Where the dialog says
  // so itself ("No, and tell Claude what to do differently (esc)") that option takes the
  // words; where it only says "No", a copy of it does.
  const refusal = read.options.find(({ label }) => label === "No" || telling(label))
  const prompts = new Set(read.options.filter(({ label }) => telling(label)).map(({ n }) => n))
  const emulated =
    refusal && !telling(refusal.label)
      ? [{ id: "tell", label: "No, and tell Claude what to do", presses: refusal.n }]
      : []
  return choices({
    title,
    detail: detail === "" ? null : detail,
    options: read.options,
    keys: digitKeys,
    // Gone: this request's dialog doesn't read any more, and the prompt is back.
    answered: (later) => permission(later, facts) === undefined && idle(later),
    prompts,
    emulated,
  })
}
