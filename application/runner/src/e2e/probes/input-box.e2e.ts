// PROBE, not a test of Novadeck: what each harness's input box looks like to a screen reader,
// in each state a prompt meets it: empty (welcome, after a turn, mid-turn), holding a draft,
// holding a pasted short text, several lines, a long line that wraps, and a long paste.
// Runs only with NOVADECK_E2E_PROBES=1, by path; writes what it saw to
// $PROBE_OUT/<agent>-<pin|latest>.json, each state as `screenText` gives it (the rows that
// show anything, the bright rows where dim cells blank some, the cursor), plus the style runs
// of its rows. The adapters'
// fixtures (harnesses/*/fixtures/input-box.probe.json) are copies of these files.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import headless from "@xterm/headless"

import { screenText } from "../../terminals/screen.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { start } from "../scenarios.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const paste = (words: string) => `\x1b[200~${words.replace(/\n/g, "\r")}\x1b[201~`
const probing = process.env.NOVADECK_E2E_PROBES === "1"
const word = (count: number) => Array.from({ length: count }, (_, i) => `w${i % 10}`).join(" ")

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: input box of ${setup.name}`, () => {
    const it = e2e(setup)
    it("empty, draft, pasted, wrapped, collapsed, mid-turn", async ({ e2e: run }) => {
      const held = gate()
      run.model.use(
        async (call) => {
          if (call.side || !asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Held." }
        },
        (call) => (!call.side && asked(call, "Say hello") ? { text: "Hello there." } : undefined),
      )
      const t = await start(run, setup)
      const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
      const out: Record<string, unknown> = {}
      const look = async (label: string) => {
        const { terminals } = run.deck
        const controller = new AbortController()
        const stream = terminals.attach(
          { terminalId: t.id, mode: "observe" },
          "reader",
          controller.signal,
        )
        try {
          for await (const event of stream) {
            if (event.type !== "snapshot") continue
            const { cols, rows } = terminals.get(t.id)
            const screen = new headless.Terminal({
              cols,
              rows,
              scrollback: 0,
              allowProposedApi: true,
            })
            await new Promise<void>((resolve) => screen.write(event.data, resolve))
            const buffer = screen.buffer.active
            const styles: Record<number, unknown[]> = {}
            const cell = buffer.getNullCell()
            for (let row = 0; row < rows; row += 1) {
              const line = buffer.getLine(buffer.viewportY + row)
              if (!line || line.translateToString(true).trim() === "") continue
              const runs: { text: string; style: string }[] = []
              for (let column = 0; column < cols; column += 1) {
                const at = line.getCell(column, cell)
                if (!at || at.getWidth() === 0) continue
                const style = [
                  at.isDim() ? "dim" : "",
                  at.isBold() ? "bold" : "",
                  at.isInverse() ? "inv" : "",
                  at.isItalic() ? "ital" : "",
                  at.isFgDefault() ? "" : `fg${at.isFgPalette() ? "p" : "rgb"}${at.getFgColor()}`,
                  at.isBgDefault() ? "" : `bg${at.isBgPalette() ? "p" : "rgb"}${at.getBgColor()}`,
                ]
                  .filter(Boolean)
                  .join(",")
                const last = runs.at(-1)
                if (last && last.style === style) last.text += at.getChars() || " "
                else runs.push({ text: at.getChars() || " ", style })
              }
              styles[row] = runs
            }
            // Sparse, as the adapters' fixtures keep it: the rows that show anything, and
            // of those the ones whose dim cells blank some of it.
            const read = screenText(screen)
            const rowsOut: Record<number, string> = {}
            const brightOut: Record<number, string> = {}
            read.rows.forEach((row, index) => {
              if (row.trim() !== "") rowsOut[index] = row.trimEnd()
              if (read.bright?.[index] !== row.trimEnd() && row.trim() !== "")
                brightOut[index] = read.bright?.[index] ?? ""
            })
            out[label] = {
              height: rows,
              cursor: read.cursor,
              rows: rowsOut,
              bright: brightOut,
              styles,
            }
            screen.dispose()
            return
          }
        } finally {
          controller.abort()
          await stream.return(undefined)
        }
      }
      // Whatever the box holds, a line at a time: Ctrl-U to the line's start, Backspace
      // across the break before it.
      let cleared = 0
      const clear = async () => {
        for (let step = 0; step < 12; step += 1) {
          raw("\x15\x7f".repeat(5))
          await sleep(120)
        }
        raw("\x15")
        await sleep(600)
        cleared += 1
        await look(`clear ${cleared}`)
      }
      const long = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the long paste`)
      const wrap = Array.from({ length: 30 }, () => "wrapping words").join(" ")

      await sleep(1500)
      await look("1 ready empty")
      raw("D")
      await sleep(800)
      await look("2 ready first key")
      await clear()
      await look("3 ready cleared")
      raw(paste("Draft of the person"))
      await sleep(1000)
      await look("4 draft pasted")
      await clear()
      raw("Typed draft")
      await sleep(800)
      await look("5 draft typed")
      await clear()
      raw(paste("go"))
      await sleep(1000)
      await look("6 short pasted")
      await clear()
      raw(paste("one\ntwo\nthree"))
      await sleep(1000)
      await look("7 three lines")
      await clear()
      raw(paste(wrap))
      await sleep(1000)
      await look("8 wrapped line")
      await clear()
      raw(paste(long.join("\n")))
      await sleep(1500)
      await look("9 long collapsed")
      await clear()
      raw(paste(long.join("\n")))
      await sleep(1500)
      raw(paste("\nand more"))
      await sleep(1000)
      await look("10 collapsed then more")
      await clear()
      await look("11 cleared again")

      // Where a box stops showing the text, or collapses it: lines and characters.
      const shapes: [string, string][] = [
        ["10 lines", Array.from({ length: 10 }, (_, i) => `Short line ${i + 1}`).join("\n")],
        ["25 lines", Array.from({ length: 25 }, (_, i) => `Short line ${i + 1}`).join("\n")],
        ["300 chars", word(100)],
        ["700 chars", word(240)],
        ["1500 chars", word(500)],
        ["4000 chars", word(1300)],
        ["12000 chars", word(4000)],
      ]
      for (const [name, words] of shapes) {
        raw(paste(words))
        await sleep(1500)
        await look(`size ${name}`)
        await clear()
      }

      // Text a person's own: indented lines, a tab, trailing spaces, blank lines; and wide
      // characters (a VS16 emoji, a ZWJ family, CJK), which TUIs and terminals count alike
      // only with the right width tables.
      for (const [name, words] of [
        ["indented", "def check():\n\tif x:   \n        return 1  # trailing   \n\n\nend"],
        [
          "emoji",
          "Thanks \u2764\ufe0f heart \u{1f468}\u200d\u{1f469}\u200d\u{1f467} family \u65e5\u672c\u8a9e",
        ],
      ] as const) {
        raw(paste(words))
        await sleep(1500)
        await look(`text ${name}`)
        await clear()
        await look(`text ${name} cleared`)
      }

      raw(paste("Say hello"))
      await sleep(800)
      raw("\r")
      await t.until("Hello there.")
      await sleep(2500)
      await look("12 after turn")
      raw(paste("Draft after turn"))
      await sleep(900)
      await look("13 draft after turn")
      await clear()

      raw(paste("Hold on"))
      await sleep(800)
      raw("\r")
      await run.model.waitFor((call) => !call.side && asked(call, "Hold on"))
      await sleep(2500)
      await look("14 mid-turn empty")
      raw(paste("go"))
      await sleep(1000)
      await look("15 mid-turn short pasted")
      await clear()
      raw(paste("one\ntwo\nthree"))
      await sleep(1000)
      await look("16 mid-turn three lines")
      await clear()
      raw(paste(long.join("\n")))
      await sleep(1500)
      await look("17 mid-turn long collapsed")
      await clear()
      held.open()
      await sleep(3000)

      const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, `${setup.agent}-${process.env.NOVADECK_E2E_HARNESS ?? "pin"}.json`),
        JSON.stringify(out, null, 2),
      )
    })
  })
}
