// PROBE, not a test of Novadeck: from how long a line each harness's box stops showing the line's
// head, at a few window sizes, and whether Novadeck then sees that the box hides text. Pastes
// one line of the length tried, as a ring does, reads the box, and erases it, closing in on the
// length. Runs only with NOVADECK_E2E_PROBES=1, by path; writes $PROBE_OUT/reply-overflow-<agent>.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { hidesText, isEmpty, tailOf } from "@novadeck/tui-input/box"

import { harnesses } from "../../harnesses/registry.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, type Call } from "../model/script.js"
import { own, start } from "../scenarios.js"
import { paste, probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
mkdirSync(out, { recursive: true })

const sizes = [40, 60, 80, 120].flatMap((cols) =>
  [14, 20, 24, 40].map((rows) => [cols, rows] as const),
)
const limit = 320

/** A line of `length` characters as a reply reads, its head and end told apart. */
const lineOf = (length: number): string => {
  const end = " [zQ7kP2]"
  const head = "[Head, zQ7kP2] "
  const words = "merge it and say so in the changelog ".repeat(12)
  return `${head}${words.slice(0, length - head.length - end.length).trimEnd()}${end}`
}

for (const setup of setups)
  describe.skipIf(!supported || !probing)(`probe: reply overflow, ${setup.name}`, () => {
    const it = e2e(setup)

    // Text that fills its row on Codex: its erase keys, and a chat send over it as a draft.
    it("a full row", { timeout: 300_000 }, async ({ e2e: run, skip }) => {
      if (setup.agent !== "codex") skip()
      run.model.use(own((call) => (asked(call, "Carry on") ? { text: "Carried on." } : undefined)))
      const terminal = await start(run, setup)
      const box = harnesses[setup.agent].box!
      const rows = 24
      terminal.resize(40, rows)
      await sleep(1_200)
      const found: unknown[] = []
      for (const length of [75, 112, 149, 186]) {
        terminal.press(paste(lineOf(length)))
        await sleep(700)
        await terminal.settled()
        const shown = await terminal.screenText()
        const read = shown && box.read(shown)
        if (read) terminal.press(box.erase!(read))
        await sleep(700)
        const after = await terminal.screenText()
        const left = after && box.read(after)
        found.push({ length, read: read?.text.length, last: read?.last, left: left?.text })
        for (let at = 0; at < 40; at += 1) {
          const now = await terminal.screenText()
          const held = now && box.read(now)
          if (held && isEmpty(held)) break
          terminal.press("\x15\x7f")
          await sleep(120)
        }
      }
      terminal.press(paste(lineOf(75)))
      await sleep(700)
      await terminal.settled()
      const mark = run.model.mark()
      const sent = await terminal.prompt("Carry on").then(
        () => "sent",
        (error: unknown) => String(error),
      )
      const call = await run.model
        .waitFor((each: Call) => !each.side && asked(each, "Carry on"), { after: mark })
        .then((each: Call) => each.turns.at(-1)?.text)
        .catch((error: unknown) => `no call: ${String(error)}`)
      writeFileSync(
        join(out, "reply-full-row.json"),
        `${JSON.stringify({ found, sent, call }, null, 2)}\n`,
      )
    })

    it("finds the length", { timeout: 900_000 }, async ({ e2e: run }) => {
      const terminal = await start(run, setup)
      const box = harnesses[setup.agent].box!
      const found: unknown[] = []

      let seen: readonly string[] | undefined

      const tryLength = async (length: number) => {
        const line = lineOf(length)
        terminal.press(paste(line))
        await sleep(700)
        await terminal.settled()
        // Read again where the program was redrawing as it was looked at.
        let shown = await terminal.screenText()
        for (let at = 0; at < 5 && !(shown && box.read(shown)); at += 1) {
          await sleep(200)
          shown = await terminal.screenText()
        }
        const read = shown && box.read(shown)
        const rows = shown?.rows.length ?? 0
        seen = shown && [
          `cursor ${shown.cursor.row},${shown.cursor.column}`,
          ...shown.rows.map((row) => row.trimEnd()),
        ]
        const result = {
          length: [...line].length,
          whole: shown?.rows.join("").replace(/\s/g, "").includes("[Head,zQ7kP2]") === true,
          hides: read ? hidesText(box, read, rows) : undefined,
          tail: read ? tailOf(box, read, rows, line) !== undefined : undefined,
          boxRows: read ? read.last - read.first + 1 : undefined,
          viewport: box.viewport?.(rows),
          text: read?.text.slice(0, 60),
        }
        for (let at = 0; at < 40; at += 1) {
          const now = await terminal.screenText()
          const held = now && box.read(now)
          if (held && isEmpty(held)) break
          terminal.press("\x15\x7f")
          await sleep(120)
        }
        return result
      }

      // How tall the box really gets on short screens, against what its profile says.
      if (process.env.PROBE_HEIGHTS) {
        for (let rows = 6; rows <= 16; rows += 1) {
          terminal.resize(40, rows)
          await sleep(1_200)
          const tried = await tryLength(limit)
          found.push({ rows, ...tried, screen: seen })
        }
        writeFileSync(
          join(out, `reply-heights-${setup.agent}.json`),
          `${JSON.stringify(found, null, 2)}\n`,
        )
        return
      }

      // Every length around a size's overflow: a box that can't be read at one would hold a ring.
      if (process.env.PROBE_SWEEP) {
        const [cols, rows] = process.env.PROBE_SWEEP.split("x").map(Number) as [number, number]
        terminal.resize(cols, rows)
        await sleep(1_200)
        for (let length = 60; length <= limit; length += Number(process.env.PROBE_STEP ?? 1)) {
          const tried = await tryLength(length)
          found.push({ ...tried, screen: seen })
        }
        writeFileSync(
          join(out, `reply-sweep-${setup.agent}-${cols}x${rows}.json`),
          `${JSON.stringify(found, null, 2)}\n`,
        )
        return
      }

      for (const [cols, rows] of sizes) {
        terminal.resize(cols, rows)
        await sleep(1_200)
        const longest = await tryLength(limit)
        if (longest.whole) {
          found.push({ cols, rows, overflow: null, longest })
          continue
        }
        let [low, high] = [40, limit]
        let first = longest
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2)
          const tried = await tryLength(middle)
          if (tried.whole) low = middle
          else {
            high = middle
            first = tried
          }
        }
        found.push({ cols, rows, overflow: high, first, longest })
        writeFileSync(
          join(out, `reply-overflow-${setup.agent}.json`),
          `${JSON.stringify(found, null, 2)}\n`,
        )
      }
      writeFileSync(
        join(out, `reply-overflow-${setup.agent}.json`),
        `${JSON.stringify(found, null, 2)}\n`,
      )
    })
  })
