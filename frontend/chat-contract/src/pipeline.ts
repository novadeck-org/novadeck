import { Transcript } from "@novadeck/chat/Transcript"
import type { ChatItem } from "@novadeck/core/conversation"
import { agentName, groupItems } from "@novadeck/core/conversation/turns"
import { transcripts as agy } from "@novadeck/harness-agy/transcripts"
import { transcripts as claude } from "@novadeck/harness-claude/transcripts"
import { transcripts as codex } from "@novadeck/harness-codex/transcripts"
import type { Harness } from "@novadeck/harness-core/harness"
import { transcriptItem } from "@novadeck/protocol"
import type { AgentName } from "@novadeck/protocol/harnesses"
import { withBatch } from "@novadeck/runner-adapter/conversations"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

// The stages between a harness's record and the rendered chat, run as the app runs them.

export type Transcripts = NonNullable<Harness["transcripts"]>

// Each harness's transcripts, whose decoder reads its records.
export const transcriptsOf: Readonly<Record<AgentName, Transcripts>> = { claude, codex, agy }

const session = "contract"

// The chat items of a conversation: each record line through its harness's decoder, the
// entries given the index the runner gives them and parsed by the protocol's strict schema,
// and mapped by the runner adapter.
export const chatItemsOf = (agent: AgentName, lines: readonly string[]): readonly ChatItem[] => {
  const entries = lines.flatMap((line) => transcriptsOf[agent].items(line))
  const batch = entries.map((entry, index) => transcriptItem.parse({ ...entry, index }))
  return withBatch([], session, batch)
}

const blockTags = new Set(["P", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "TR", "DIV"])
const heading = /^H[1-6]$/

// An element's text as a reader sees it: line breaks where blocks and breaks are, each line
// trimmed, and the lines joined with a marker, so one block stays one line of a golden.
const textOf = (element: Element): string => {
  let text = ""
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? ""
    else if (node instanceof Element) {
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

// The fold's line: its count and the titles, which the chat sets in spans of their own.
const foldText = (fold: Element): string =>
  [...fold.querySelectorAll("span")].map((span) => textOf(span)).join(" · ")

const clip = (text: string, to: number): string =>
  text.length > to ? `${text.slice(0, to - 1)}…` : text

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

// What an opened part of a tool row (its call, its result) shows: its line count and first
// line, and whether the chat says it was shortened.
const partOf = (part: Element | null): string => {
  if (!part) return "none"
  const body = part.querySelector("pre")?.textContent ?? ""
  const shortened = part.querySelector(".chat-tool-note") ? ", shortened" : ""
  if (body === "(empty)") return `empty${shortened}`
  const lines = body.replace(/\n$/, "").split("\n")
  // The first line that says anything: some begin with a blank one.
  const first = lines.find((line) => line.trim() !== "") ?? ""
  return `${lines.length} ${lines.length === 1 ? "line" : "lines"}${shortened}: ${clip(first.trim(), 48)}`
}

// A row as the chat draws it: its title, its kind (which picks the icon) and its detail, then
// the call it opens to (the label the chat gives it, its lines) and the result.
const rowOf = (row: Element): string => {
  const title = row.querySelector(".chat-tool-title")?.textContent ?? ""
  const detail = row.querySelector(".chat-tool-detail")?.textContent
  const summary = row.querySelector("button.chat-tool-summary")
  if (summary?.getAttribute("aria-expanded") === "false") click(summary)
  const call = row.querySelector('section[aria-label^="Call"]')
  const result = row.querySelector('section[aria-label="Result"]')
  const note = result ? "" : (row.querySelector(".chat-tool-note")?.textContent ?? "")
  return [
    `${title} [${row.getAttribute("data-kind")}]${detail ? ` · ${detail}` : ""}`,
    call ? ` | ${call.getAttribute("aria-label")}: ${partOf(call)}` : "",
    ` → ${result ? partOf(result) : note.replace(/…$/, "").toLowerCase()}`,
  ].join("")
}

// One line of a golden per block, from what the DOM shows. A folded run is opened, each of
// its rows too, so what they hold is read.
const lineOf = (block: Element): { line: string; rows: number } => {
  if (block.matches(".chat-tools")) {
    const fold = block.querySelector("button.chat-tools-fold")
    const folded = fold ? `[${foldText(fold)}] ` : ""
    if (fold?.getAttribute("aria-expanded") === "false") click(fold)
    const rows = [...block.querySelectorAll("li.chat-tool")].map(rowOf)
    return { line: `tools: ${folded}${rows.join("; ")}`, rows: rows.length }
  }
  if (block.matches(".chat-note")) return { line: `note: ${textOf(block)}`, rows: 0 }
  const role = block.getAttribute("data-role")
  if (role === "agent") {
    const from = block.getAttribute("aria-label")?.replace(/^Message from /, "") ?? ""
    const bubble = block.querySelector(".chat-bubble")!.cloneNode(true) as Element
    bubble.querySelector(".chat-author")?.remove()
    return { line: `agent (${from}): ${textOf(bubble)}`, rows: 0 }
  }
  if (role === "user" || role === "assistant") return { line: `${role}: ${textOf(block)}`, rows: 0 }
  throw new Error(`The chat rendered a block this contract does not know: ${block.outerHTML}`)
}

export type Rendered = {
  // One line per block.
  readonly lines: readonly string[]
  // How many tool rows the chat drew.
  readonly toolRows: number
}

// The conversation as the UI draws it: core's blocks through the real Transcript in jsdom,
// with the agent named as the chat names it.
export const renderChat = (items: readonly ChatItem[], agent: AgentName): Rendered => {
  const view = render(
    createElement(Transcript, {
      blocks: groupItems(items),
      agent: agentName(agent),
      working: false,
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
