import type { ToolChange, ToolKind, ToolOutcome, ToolRun } from "@novadeck/core/conversation"
import type { ToolEntry } from "@novadeck/core/conversation/turns"
import { counted } from "@novadeck/core/units"

// What a tool call's one line says, read off its entry. Pure, so the words read apart from the
// markup.

// What a call was, as its decoder said; a call with none shows its tool's name. Nothing for a
// result whose call is outside the window.
export const callRun = (entry: ToolEntry): ToolRun | null =>
  entry.tool === null ? null : (entry.run ?? { kind: "other", title: entry.tool, detail: "" })

// A decoder's title as the line says it: "Ran" is "ran". A name stays as it is: "MCP tool", and
// the name of a tool no decoder knows, "TeamCreate".
export const verbOf = (title: string): string =>
  /^\p{Lu}\p{Ll}*(?: |$)/u.test(title) ? `${title.charAt(0).toLowerCase()}${title.slice(1)}` : title

// A title for a call that still goes: only a command's has a word of its own.
export const runningVerb = (run: ToolRun): string =>
  run.kind === ("run" satisfies ToolKind) && run.title === "Ran" ? "running" : verbOf(run.title)

const failedOutcome = (outcome: ToolOutcome): boolean =>
  outcome.failed ?? (outcome.exit !== null && outcome.exit !== 0)

const sizeWords = ({ count, unit }: NonNullable<ToolOutcome["size"]>): string =>
  unit === "match" ? `${count} ${count === 1 ? "match" : "matches"}` : counted(count, unit)

// What came of a call, for the end of its line: that it failed, what it changed, what it goes on
// doing, or how much it found; null where its harness doesn't say. A call that runs on past its
// result says nothing of when it ended, so the line never claims it still runs.
export type ToolNote =
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "change"; readonly added: number; readonly removed: number }
  | { readonly kind: "said"; readonly text: string }

export const toolNote = ({ outcome }: ToolEntry): ToolNote | null => {
  if (outcome && failedOutcome(outcome))
    return { kind: "failed", text: outcome.exit ? `exit ${outcome.exit}` : "failed" }
  if (outcome?.change) {
    const { added, removed } = outcome.change
    return { kind: "change", added, removed }
  }
  if (outcome?.running) return { kind: "said", text: "in the background" }
  if (outcome?.size) return { kind: "said", text: sizeWords(outcome.size) }
  return null
}

// How many of the calls failed, for a line that stands for them.
export const failedCount = (entries: readonly ToolEntry[]): number =>
  entries.filter((entry) => toolNote(entry)?.kind === "failed").length

// How many lines a change counted past those it carries.
export const moreChanged = ({ added, removed, lines }: ToolChange): number =>
  added + removed - lines.filter((line) => line.sign !== " ").length

// What a run of calls did, in a line: its calls' titles, each counted where it came twice.
export const foldSummary = (entries: readonly ToolEntry[]): string => {
  const titles = new Map<string, number>()
  for (const entry of entries) {
    const title = callRun(entry)?.title
    if (title !== undefined) titles.set(title, (titles.get(title) ?? 0) + 1)
  }
  return [...titles]
    .slice(0, 4)
    .map(([title, count]) => (count > 1 ? `${verbOf(title)} ×${count}` : verbOf(title)))
    .join(", ")
}

// A line of a run: its call, and the calls made inside its script, which fold under it. Nothing
// names a call's script, only that it came before, and a call that outlived its script lands
// after others: this groups what is drawn, in the order it came, and changes no entry.
export type ToolLine = { readonly entry: ToolEntry; readonly scripted: readonly ToolEntry[] }

export const toolLines = (entries: readonly ToolEntry[]): readonly ToolLine[] => {
  const lines: { readonly entry: ToolEntry; readonly scripted: ToolEntry[] }[] = []
  for (const entry of entries) {
    const last = lines.at(-1)
    if (entry.scripted && last && !last.entry.scripted) last.scripted.push(entry)
    else lines.push({ entry, scripted: [] })
  }
  return lines
}
