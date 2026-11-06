import { readdirSync } from "node:fs"
import { join } from "node:path"

import type { ToolOutcome } from "@novadeck/core/conversation"
import { groupItems, type ToolEntry } from "@novadeck/core/conversation/turns"
import { agentNames, type AgentName } from "@novadeck/protocol/harnesses"

import { outcomeFixtures, type Fixture } from "./fixtures"
import { chatItemsOf } from "./pipeline"
import { describe, expect, it } from "./test"

// What each harness records of a tool's outcome, read as the app reads it: every case of
// every harness, through its decoder, the protocol's schema, the runner adapter and
// `groupItems`, to the entry the chat gets, against `src/outcomes/<harness>.txt`. A harness
// update that changes a word these read shows here as a diff, not as wrong numbers.

const entriesOf = ({ harness }: Fixture, lines: readonly string[]): readonly ToolEntry[] =>
  groupItems(chatItemsOf(harness, lines)).flatMap((block) =>
    block.kind === "tools" ? block.entries : [],
  )

const conversations = (fixture: Fixture) => fixture.extract().conversations

const conversationOf = (harness: AgentName, name: string): readonly ToolEntry[] => {
  const fixture = outcomeFixtures.find((each) => each.harness === harness)!
  const found = conversations(fixture).find((each) => each.name === name)
  if (!found) throw new Error(`${harness} has no case ${name}`)
  return entriesOf(fixture, found.lines)
}

const entryOf = (harness: AgentName, name: string): ToolEntry => {
  const entries = conversationOf(harness, name)
  expect(entries, `${harness} ${name}`).toHaveLength(1)
  return entries[0]!
}

const changeText = ({ added, removed, lines }: NonNullable<ToolOutcome["change"]>): string => {
  const first = lines
    .slice(0, 3)
    .map(({ sign, text, line }) => `${line ?? "?"}${sign}${text.slice(0, 24)}`)
  return `+${added} -${removed} [${lines.length} lines: ${first.join(" | ")}]`
}

const outcomeText = (outcome: ToolOutcome | null): string => {
  if (!outcome) return "nothing known"
  const { failed, exit, running, size, change } = outcome
  return [
    `failed ${failed === null ? "unknown" : failed}`,
    exit === null ? "" : `exit ${exit}`,
    running ? "running" : "",
    size ? `${size.count} ${size.unit}s` : "",
    change ? changeText(change) : "",
  ]
    .filter(Boolean)
    .join(", ")
}

const lineOf = (entry: ToolEntry): string =>
  `${entry.scripted ? "  in script: " : ""}${entry.run?.title} · ${entry.run?.detail.slice(0, 40)} → ${outcomeText(entry.outcome)}`

const golden = (fixture: Fixture): string =>
  `${conversations(fixture)
    .map(({ name, lines }) => `# ${name}\n${entriesOf(fixture, lines).map(lineOf).join("\n")}`)
    .join("\n\n")}\n`

describe("each harness's tool outcomes, from recorded transcripts", () => {
  for (const fixture of outcomeFixtures)
    it(`reads ${fixture.harness}'s as its golden`, async () => {
      await expect(golden(fixture)).toMatchFileSnapshot(`./outcomes/${fixture.harness}.txt`)
    })

  it("keeps a golden for every harness, and no other", () => {
    const kept = readdirSync(join(import.meta.dirname, "outcomes"))
    expect(kept.toSorted()).toEqual(agentNames.map((name) => `${name}.txt`).toSorted())
  })

  it("says a command failed on every harness's own word, with its code", () => {
    for (const [harness, name] of [
      ["claude", "command-fails"],
      ["codex", "direct: command-fails"],
      ["agy", "command-fails"],
    ] as const)
      expect(entryOf(harness, name).outcome, harness).toMatchObject({ failed: true, exit: 3 })
    expect(conversationOf("codex", "code mode: command-fails")[1]!.outcome).toMatchObject({
      failed: true,
      exit: 3,
    })
  })

  it("says an edit that failed to match failed, and counts no change", () => {
    for (const [harness, name] of [
      ["claude", "edit-no-match"],
      ["codex", "direct: patch-no-match"],
      ["codex", "patch tool: no-match"],
      ["codex", "code mode: no-match"],
      ["agy", "edit-no-match"],
    ] as const)
      expect(entryOf(harness, name).outcome, `${harness} ${name}`).toMatchObject({
        failed: true,
        change: null,
      })
  })

  it("counts an edit on every harness", () => {
    expect(entryOf("claude", "edit").outcome?.change).toMatchObject({ added: 2, removed: 1 })
    expect(entryOf("codex", "patch tool: update").outcome?.change).toMatchObject({
      added: 2,
      removed: 1,
    })
    expect(entryOf("agy", "edit").outcome?.change).toMatchObject({ added: 2, removed: 1 })
    expect(conversationOf("codex", "code mode: update")[1]!.outcome?.change).toMatchObject({
      added: 2,
      removed: 1,
    })
  })

  it("keeps its counts true of an input past the item's cut", () => {
    for (const [harness, name, added, removed] of [
      ["claude", "long-edit", 2, 2],
      ["claude", "long-write", 400, 0],
      ["agy", "long-edit", 2, 2],
      ["agy", "long-write", 400, 0],
    ] as const) {
      const entry = entryOf(harness, name)
      expect(entry.truncated || entry.result?.truncated, `${harness} ${name}`).toBe(true)
      expect(entry.outcome?.change, `${harness} ${name}`).toMatchObject({ added, removed })
      expect(entry.outcome?.change?.lines.length, `${harness} ${name}`).toBeGreaterThan(0)
    }
  })

  it("says a command that runs on is neither passed nor failed", () => {
    for (const [harness, name] of [
      ["claude", "background"],
      ["codex", "direct: runs-on"],
      ["agy", "background"],
    ] as const)
      expect(entryOf(harness, name).outcome, harness).toMatchObject({
        running: true,
        failed: null,
      })
  })

  it("counts what a harness states it read, and nothing it doesn't", () => {
    expect(entryOf("claude", "read").outcome?.size).toEqual({ count: 6, unit: "line" })
    expect(entryOf("claude", "read-part").outcome?.size).toEqual({ count: 2, unit: "line" })
    expect(entryOf("agy", "read").outcome?.size).toEqual({ count: 6, unit: "line" })
    expect(entryOf("agy", "read-part").outcome?.size).toEqual({ count: 2, unit: "line" })
    expect(entryOf("codex", "direct: read").outcome?.size).toBeNull()
    for (const [harness, name] of [
      ["claude", "search"],
      ["codex", "direct: search"],
      ["agy", "search"],
    ] as const)
      expect(entryOf(harness, name).outcome?.size, `${harness} ${name}`).toBeNull()
  })

  it("takes no exit code Claude Code doesn't state", () => {
    // A grep that found nothing: exit 1 to the shell, no failure to Claude Code.
    expect(entryOf("claude", "no-match").outcome).toMatchObject({ failed: false, exit: null })
    expect(entryOf("claude", "command-passes").outcome).toMatchObject({ failed: false, exit: null })
  })

  it("counts the lines of what Codex itself took for a read", () => {
    expect(conversationOf("codex", "code mode: read")[1]!.outcome?.size).toEqual({
      count: 6,
      unit: "line",
    })
    expect(conversationOf("codex", "code mode: search")[1]!.outcome?.size).toBeNull()
  })

  it("gives a Codex call one row, with its event or without", () => {
    const fixture = outcomeFixtures.find(({ harness }) => harness === "codex")!
    for (const { name, lines } of conversations(fixture)) {
      if (name.startsWith("code mode:")) continue
      const events = lines.filter((line) => line.includes('"item_completed"')).length
      const entries = entriesOf(fixture, lines)
      expect(entries, name).toHaveLength(1)
      expect(entries[0]!.scripted, name).toBe(false)
      if (name.endsWith("command-passes")) expect(events, name).toBe(1)
    }
  })

  it("shows what a Codex script ran as rows after the script's, marked", () => {
    const entries = conversationOf("codex", "code mode: two-commands")
    expect(entries.map(({ scripted }) => scripted)).toEqual([false, true, true])
    // In the order they ended, as the record has them.
    const [echoed, missing] = entries
      .slice(1)
      .toSorted((a, b) =>
        a.run?.detail === "echo one" ? -1 : b.run?.detail === "echo one" ? 1 : 0,
      )
    expect(entries[0]!.outcome).toBeNull()
    expect(echoed).toMatchObject({
      run: { detail: "echo one" },
      outcome: { failed: false, exit: 0 },
    })
    expect(missing).toMatchObject({
      run: { detail: "cat missing.txt" },
      outcome: { failed: true, exit: 1 },
    })
  })

  it("fails a Codex script only on its own word", () => {
    expect(conversationOf("codex", "code mode: command-fails")[0]!.outcome).toBeNull()
    expect(entryOf("codex", "code mode: script-fails").outcome).toMatchObject({ failed: true })
  })

  it("numbers a Codex patch where it records the lines", () => {
    const lines = conversationOf("codex", "code mode: update")[1]!.outcome?.change?.lines
    expect(lines).toEqual([
      { sign: " ", text: "const a = 1", line: 1 },
      { sign: "-", text: "const b = 2", line: 2 },
      { sign: "+", text: "const b = 20", line: 2 },
      { sign: "+", text: "const bb = 21", line: 3 },
      { sign: " ", text: "const c = 3", line: 4 },
    ])
  })
})
