// PROBE, not a test of Novadeck: what each harness draws at its input of its own (the `/`
// menu, `$` skills, the `@` picker, a command's own view), where on the screen, how it grows
// and closes, and which keys it takes, for the chat's live slice. Runs only with
// NOVADECK_E2E_PROBES=1, by path; writes what it saw to $PROBE_OUT/<agent>-<pin|latest>.json,
// each state a `ScreenRecord` plus the style runs of its rows, and what the transcript
// holds of the commands it ran. PROBE_KEYS (a JSON array of steps) replaces the fixed list.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { createScreen, readScreen } from "@novadeck/emulator/headless"
import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { start } from "../scenarios.js"
import { sleep, probing } from "./support.js"

const keys: Record<string, string> = {
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  tab: "\t",
  enter: "\r",
  kill: "\x15",
  ctrlc: "\x03",
  bs: "\x7f",
}

/** A step: text to type, or `<name>` for a key; `@rows,cols` resizes; `#label` only looks. */
const round: Record<string, readonly string[]> = {
  menu: [
    "/",
    "m",
    "o",
    "<down>",
    "<down>",
    "<up>",
    "<tab>",
    "<esc>",
    "<kill>",
    "/",
    "<down>",
    "<down>",
    "<down>",
    "<down>",
    "<down>",
    "<down>",
    "<down>",
    "<down>",
    "<down>",
    "<down>",
    "<down>",
    "<down>",
    "<esc>",
    "<esc>",
    "<kill>",
    "/zzzz",
    "<kill>",
    "/",
    "<enter>",
    "<kill>",
    "@",
    "s",
    "<down>",
    "<up>",
    "<esc>",
    "<kill>",
    "@",
    "<tab>",
    "<esc>",
    "<kill>",
    "text @",
    "<esc>",
    "<kill>",
    "$",
    "s",
    "<esc>",
    "<kill>",
  ],
}

const files: Record<string, string> = {
  "README.md": "# Sample\n",
  "src/server.ts": "export const server = 1\n",
  "src/auth.ts": "export const auth = 1\n",
  "src/store.ts": "export const store = 1\n",
  ".claude/commands/sample-command.md": "Say the word sample.\n",
  ".agents/skills/sample-skill/SKILL.md":
    "---\nname: sample-skill\ndescription: A sample skill for the probe\n---\nSay the word sample.\n",
}

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: live slice of ${setup.name}`, () => {
    const it = e2e(setup)
    it("menus and views", { timeout: 600_000 }, async ({ e2e: run }) => {
      const held = gate()
      run.model.use(
        async (call) => {
          if (call.side || !asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Held." }
        },
        (call) =>
          !call.side && asked(call, "Say hello")
            ? { text: "Hello there.\n\nA reply with a few lines.\n\nAnd one more." }
            : undefined,
        (call) =>
          !call.side && asked(call, "Say a lot")
            ? {
                text: Array.from({ length: 80 }, (_, i) => `Long line ${i + 1}`).join("\n\n"),
              }
            : undefined,
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
            const screen = createScreen({ cols, rows, scrollback: 0 })
            await new Promise<void>((resolve) => screen.write(event.data, resolve))
            const buffer = screen.buffer.active
            const styles: Record<number, unknown[]> = {}
            const cell = buffer.getNullCell()
            for (let row = 0; row < rows; row += 1) {
              const line = buffer.getLine(buffer.viewportY + row)
              if (!line || line.translateToString(true).trim() === "") continue
              const spans: { text: string; style: string }[] = []
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
                const last = spans.at(-1)
                if (last && last.style === style) last.text += at.getChars() || " "
                else spans.push({ text: at.getChars() || " ", style })
              }
              styles[row] = spans
            }
            const read = readScreen(screen)
            out[label] = {
              ...screenRecord(read),
              alternate: read.alternate,
              size: { cols, rows },
              at: Date.now(),
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
      let step = 0
      const name = (text: string) => `${String((step += 1)).padStart(3, "0")} ${text}`
      const steps = async (list: readonly string[]) => {
        for (const item of list) {
          if (item.startsWith("#")) {
            await look(name(item))
            continue
          }
          if (item.startsWith("=")) {
            raw(item.slice(1))
            await sleep(900)
            raw("\r")
            for (let waited = 0; waited < 40; waited += 1) {
              await sleep(500)
              if ((await t.screen()).includes("Long line 80")) break
            }
            await sleep(2500)
            await look(name("long reply"))
            continue
          }
          if (item.startsWith("~")) {
            await sleep(Number(item.slice(1)))
            continue
          }
          const many = /^<(\w+)>\*(\d+)$/.exec(item)
          if (many) {
            for (let n = 0; n < Number(many[2]); n += 1) {
              raw(keys[many[1]!]!)
              await sleep(180)
              await look(name(`${many[1]} ${n}`))
            }
            continue
          }
          const size = /^@(\d+),(\d+)$/.exec(item)
          if (size) {
            t.resize(Number(size[2]), Number(size[1]))
            await sleep(900)
            await look(name(item))
            continue
          }
          const key = /^<(\w+)>$/.exec(item)
          raw(key ? keys[key[1]!]! : item)
          await sleep(key?.[1] === "enter" ? 1800 : 800)
          await look(name(item.replaceAll(/[^\w<>@$/ ]/g, "_")))
        }
      }

      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(run.sandbox.project, path)), { recursive: true })
        writeFileSync(join(run.sandbox.project, path), text)
      }
      await sleep(1500)
      await look(name("idle"))
      raw("Say hello")
      await sleep(900)
      raw("\r")
      for (let waited = 0; waited < 40; waited += 1) {
        await sleep(500)
        if ((await t.screen()).includes("one more")) break
      }
      await sleep(2500)
      await look(name("after a reply"))
      const list = process.env.PROBE_KEYS
        ? (JSON.parse(readFileSync(process.env.PROBE_KEYS, "utf8")) as Record<string, string[]>)[
            setup.agent
          ]!
        : round.menu!
      await steps(list)
      if (process.env.PROBE_HOLD === "1") {
        raw("Hold on")
        await sleep(900)
        raw("\r")
        await sleep(2000)
        await look(name("mid-turn"))
        await steps(["/", "<down>", "<esc>", "<kill>", "@", "<esc>", "<kill>"])
        held.open()
        await sleep(1500)
      }
      const shown = await t.transcript().catch((error: unknown) => String(error))
      const dir = process.env.PROBE_OUT ?? "."
      mkdirSync(dir, { recursive: true })
      const store = join(dir, `${setup.agent}-store`)
      for (const from of [".claude/projects", ".codex/sessions", ".gemini/antigravity-cli"]) {
        const path = join(run.sandbox.home, from)
        if (existsSync(path)) cpSync(path, join(store, from), { recursive: true, force: true })
      }
      writeFileSync(
        join(dir, `${setup.agent}-${process.env.NOVADECK_E2E_HARNESS ?? "pin"}.json`),
        JSON.stringify({ states: out, transcript: shown }, null, 1),
      )
    })
  })
}
