import type { SentBubble } from "@novadeck/chat/bubbles"
import { Transcript } from "@novadeck/chat/Transcript"
import type { ChatItem } from "@novadeck/core/conversation"
import { agentName, groupItems } from "@novadeck/core/conversation/turns"
import { transcripts as agy } from "@novadeck/harness-agy/transcripts"
import { transcripts as claude } from "@novadeck/harness-claude/transcripts"
import { transcripts as codex } from "@novadeck/harness-codex/transcripts"
import type { TranscriptDecoder, TranscriptEntry } from "@novadeck/harness-core/harness"
import { transcriptItem } from "@novadeck/protocol"
import type { AgentName } from "@novadeck/protocol/harnesses"
import { withBatch } from "@novadeck/runner-adapter/conversations"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

// The stages between a harness's record and the rendered chat, run as the app runs them.

type Transcripts = TranscriptDecoder

// Each harness's transcripts, whose decoder reads its records.
export const transcriptsOf: Readonly<Record<AgentName, Transcripts>> = { claude, codex, agy }

const session = "contract"

// The chat items of a conversation: each record line through its harness's decoder, the
// entries given the index the runner gives them and parsed by the protocol's strict schema,
// and mapped by the runner adapter.
export const chatItemsOf = (harness: AgentName, lines: readonly string[]): readonly ChatItem[] =>
  chatItemsFrom(lines.flatMap((line) => transcriptsOf[harness].items(line)))

// The chat items of a transcript's entries, as the runner numbers and sends them, whether a
// harness's decoder read them or the runner joined one of its own.
export const chatItemsFrom = (entries: readonly TranscriptEntry[]): readonly ChatItem[] => {
  const batch = entries.map((entry, index) => transcriptItem.parse({ ...entry, index }))
  return withBatch([], session, batch)
}

const blockTags = new Set(["P", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "TR", "DIV"])
const heading = /^H[1-6]$/

// An element's text as a reader sees it: line breaks where blocks and breaks are, each line
// trimmed, and the lines joined with a marker, so one block stays one line of a golden. What is
// hidden from readers (`aria-hidden`, as a row's facts at its edge: times and clocks, which depend
// on the machine and the moment) is not read; the element itself is read whatever it says.
const textOf = (element: Element): string => {
  let text = ""
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? ""
    else if (node instanceof Element) {
      if (node !== element && node.getAttribute("aria-hidden") === "true") return
      const block = blockTags.has(node.tagName) || heading.test(node.tagName)
      if (block || node.tagName === "BR") text += "\n"
      node.childNodes.forEach(walk)
      if (block) text += "\n"
    }
  }
  walk(element)
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ⏎ ")
}

const clip = (text: string, to: number): string =>
  text.length > to ? `${text.slice(0, to - 1)}…` : text

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

// What an opened part of a tool row (its call, its result) shows: its line count and first
// line, and whether the chat says it was shortened. A diff is a line to each span.
const partOf = (part: Element | null): string => {
  if (!part) return "none"
  const diff = [...part.querySelectorAll(".chat-diff")].map((line) => line.textContent)
  const body = diff.length > 0 ? diff.join("\n") : (part.querySelector("pre")?.textContent ?? "")
  const shortened = part.querySelector(".chat-tool-note") ? ", shortened" : ""
  if (body === "(empty)") return `empty${shortened}`
  const lines = body.replace(/\n$/, "").split("\n")
  // The first line that says anything: some begin with a blank one.
  const first = lines.find((line) => line.trim() !== "") ?? ""
  return `${lines.length} ${lines.length === 1 ? "line" : "lines"}${shortened}: ${clip(first.trim(), 48)}`
}

// A row as the chat draws it: its title, its kind, its detail and what came of it, then the call
// it opens to (the label the chat gives it, its lines) and the result or the diff.
const rowOf = (row: Element): string => {
  const summary = row.querySelector(":scope > button.chat-tool-summary")
  const title = summary?.querySelector(".chat-tool-title")?.textContent ?? ""
  const detail = summary?.querySelector(".chat-tool-detail")?.textContent
  const end = summary?.querySelector(".chat-tool-end")?.textContent?.replace(/\s+/g, " ").trim()
  if (summary?.getAttribute("aria-expanded") === "false") click(summary)
  const part = (label: string): Element | null =>
    row.querySelector(`:scope > .chat-tool-body > section[aria-label${label}]`)
  const call = part('^="Call"')
  const result = part('="Result"') ?? part('="Changes"')
  const note = result
    ? ""
    : (row.querySelector(":scope > .chat-tool-body > .chat-tool-note")?.textContent ?? "")
  return [
    `${title} [${row.getAttribute("data-kind")}]${detail ? ` · ${detail}` : ""}${end ? ` ${end}` : ""}`,
    call ? ` | ${call.getAttribute("aria-label")}: ${partOf(call)}` : "",
    ` → ${result ? partOf(result) : note.replace(/…$/, "").toLowerCase()}`,
  ].join("")
}

// The rows of a list, each opened, with the rows drawn under it once it is: the calls made inside
// its script.
const rowsOf = (list: Element): readonly string[] =>
  [...list.querySelectorAll(":scope > li.chat-tool")].flatMap((row) => {
    const line = rowOf(row)
    const under = row.querySelector(":scope > .chat-tool-body > .chat-tools-list")
    return [line, ...(under ? rowsOf(under).map((each) => `in script: ${each}`) : [])]
  })

const unknownBlock = (block: Element): Error =>
  new Error(`The chat rendered a block this contract does not know: ${block.outerHTML}`)

// One line of a golden per block, from what the DOM shows. A folded run is opened, each of
// its rows too, so what they hold is read.
const lineOf = (block: Element): { line: string; rows: number } => {
  // A line of the record no one said: what it says, then what it opens to.
  if (block.matches(".chat-record")) {
    const line = block.querySelector(".chat-tool-summary")!
    if (line.matches("button")) click(line)
    const body = block.querySelector(".chat-tool-part")
    const kind = block.getAttribute("data-kind")
    return {
      line: `${kind}: ${textOf(line)} → ${body ? partOf(body) : "nothing to open"}`,
      rows: 0,
    }
  }
  if (block.matches(".chat-tools")) {
    const fold = block.querySelector("button.chat-tools-fold")
    // A fold that starts open (a live run's) says so; a finished one starts shut.
    const state = fold?.getAttribute("aria-expanded")
    if (fold && state !== "true" && state !== "false") throw unknownBlock(block)
    const folded = fold ? `[${state === "true" ? "open: " : ""}${textOf(fold)}] ` : ""
    if (fold && state === "false") click(fold)
    const rows = rowsOf(block.querySelector(":scope > .chat-tools-list")!)
    return { line: `tools: ${folded}${rows.join("; ")}`, rows: rows.length }
  }
  // A subagent's report: its name, whether it runs or failed, and the whole of what it said.
  if (block.matches(".chat-subagent")) {
    const line = block.querySelector<HTMLElement>(".chat-subagent-summary")!
    if (line.getAttribute("aria-expanded") === "false") click(line)
    const name = textOf(block.querySelector(".chat-subagent-name")!)
    const state = block.hasAttribute("data-failed")
      ? ", failed"
      : block.hasAttribute("data-running")
        ? ", running"
        : ""
    const body = block.querySelector(".chat-tool-body")
    const short = body?.querySelector(".chat-tool-note, .chat-shortened") ? ", shortened" : ""
    const said = body?.querySelector(".markdown")
    return { line: `subagent (${name}${state}${short}): ${said ? textOf(said) : "…"}`, rows: 0 }
  }
  if (block.matches(".chat-note")) return { line: `note: ${textOf(block)}`, rows: 0 }
  if (block.getAttribute("data-role") === "doorbell") {
    const brought = [...block.querySelectorAll(":scope > [data-role]")].map((message) => {
      const words = message.cloneNode(true) as Element
      words.querySelector(".chat-author")?.remove()
      const from = message.querySelector(".chat-author")?.textContent ?? "you"
      return `${from}: ${textOf(words)}`
    })
    const line = textOf(block.querySelector(":scope > .chat-note")!)
    return { line: `doorbell: ${[line, ...brought].join(" | ")}`, rows: 0 }
  }
  const sent = block.getAttribute("data-sent")
  if (sent) {
    const prompt = block.querySelector(".chat-text")
    const note = block.querySelector(".chat-sent")
    const words = note?.querySelector("span")
    const tag = prompt?.querySelector(".chat-sent-tag")
    if (!prompt || (note && !words) || (!note && !tag)) throw unknownBlock(block)
    const buttons = [...(note?.querySelectorAll("button") ?? [])].map((each) => each.textContent)
    const said = tag?.textContent ?? (words ? textOf(words) : "")
    const asked = prompt.cloneNode(true) as Element
    asked.querySelector(".chat-sent-tag")?.remove()
    return {
      line: `sent (${sent}): ${textOf(asked)} · ${said}${buttons.length > 0 ? ` [${buttons.join(", ")}]` : ""}`,
      rows: 0,
    }
  }
  const role = block.getAttribute("data-role")
  if (role === "agent") {
    const from = block.getAttribute("aria-label")?.replace(/^Message from /, "") ?? ""
    const words = block.cloneNode(true) as Element
    words.querySelector(".chat-author")?.remove()
    return { line: `agent (${from}): ${textOf(words)}`, rows: 0 }
  }
  if (role === "user" || role === "assistant") return { line: `${role}: ${textOf(block)}`, rows: 0 }
  throw unknownBlock(block)
}

export type Rendered = {
  // One line per block.
  readonly lines: readonly string[]
  // How many tool rows the chat drew.
  readonly toolRows: number
}

// The conversation as the UI draws it: core's blocks through the real Transcript in jsdom,
// with the agent named as the chat names it, and the person's prompts the record doesn't show
// yet among them (`sent`). Finished, unless `working` says the agent still works on it.
export const renderChat = (
  items: readonly ChatItem[],
  harness: AgentName,
  sent: readonly SentBubble[] = [],
  { working = false }: { readonly working?: boolean } = {},
): Rendered => {
  const view = render(
    createElement(Transcript, {
      blocks: groupItems(items),
      agent: agentName(harness),
      working,
      sent,
      onResend: () => {},
      onEdit: () => {},
      onShowTerminal: () => {},
    }),
  )
  try {
    const drawn = [...view.container.children].map(lineOf)
    return {
      lines: drawn.map(({ line }) => line),
      toolRows: drawn.reduce((sum, { rows }) => sum + rows, 0),
    }
  } finally {
    view.unmount()
  }
}
