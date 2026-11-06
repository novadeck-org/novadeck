// PROBE (#757): what Claude Code's screen shows of a queue with something in its box, for the
// rule that Up goes only where the queued row shows; the cursor-key mode it sets; and what a
// Stop does with a doorbell line queued. Runs only with NOVADECK_E2E_PROBES=1, by path;
// writes $PROBE_OUT/queued-box.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { claude } from "../agents/claude.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { own, start } from "../scenarios.js"
import { paste, probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
mkdirSync(out, { recursive: true })
const file = join(out, "queued-box.json")
const load = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}
const save = (name: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify({ ...load(), [name]: value }, null, 2)}\n`)

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `draft line ${i + 1}`).join("\n")
const contents: Record<string, string> = {
  emptyQueue: "",
  oneLine: "my draft",
  space: " ",
  twoLines: paste(lines(2)),
  threeLines: paste(lines(3)),
  placeholder: paste(lines(10)),
  longPaste: paste("x".repeat(1200)),
  slash: "/",
  shell: "!",
  image: "IMAGE",
  typedThenDeleted: "x\u007f",
  hash: "#",
  amp: "&",
  plan: "\u001b[Z",
  historySearch: "\u0012",
  shortcuts: "?",
  shortcutsNarrow: "?",
  recall: "\u001b[A",
  fourLines: paste(lines(4)),
}

describe.skipIf(!supported || !probing)("probe: Claude Code's box with a queue", () => {
  const it = e2e(claude)
  for (const [name, keys] of Object.entries(contents))
    it(`${name}`, { timeout: 60_000 }, async ({ e2e: run }) => {
      const held = gate()
      run.model.use(
        own(async (call) => {
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, claude)
      const mark = t1.mark()
      await t1.prompt("Hold on")
      await t1.reached("working", { after: mark })
      await sleep(1500)
      if (name === "shortcutsNarrow") {
        t1.resize(80, 24)
        await sleep(500)
      }
      if (name !== "recall") {
        await t1.prompt("Queued beta")
        await t1.until(/Press up to edit queued messages/)
      }
      const typed = keys === "IMAGE" ? paste(join(run.sandbox.project, "shot.png")) : keys
      if (keys === "IMAGE")
        writeFileSync(
          join(run.sandbox.project, "shot.png"),
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
            "base64",
          ),
        )
      const live = (
        run.deck.terminals as unknown as {
          live(id: string): {
            terminal: {
              screen: { modes?: { applicationCursorKeysMode?: boolean } }
              pty: { write(data: string): void }
            }
          }
        }
      ).live(t1.id)
      // Written as a paste's own keys go: its line breaks are no Enter to send anything.
      if (typed) live.terminal.pty.write(typed)
      await sleep(1500)
      const screen = await t1.screenText()
      const mode = live.terminal.screen.modes?.applicationCursorKeysMode
      save(name, {
        record: screen && screenRecord(screen),
        row: screen?.rows.some((row) => row.includes("Press up to edit queued messages")),
        applicationCursorKeys: mode,
      })
      held.open()
    })
})
