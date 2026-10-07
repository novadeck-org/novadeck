// PROBE, not a test of Novadeck: what each harness does with a prompt that starts with `!`
// (shell mode), pasted as the chat pastes a prompt (one bracketed paste, then Enter) or with
// the `!` typed first; what its screens show, whether it runs at once or queues mid-turn, and
// what its session files record. Runs only with NOVADECK_E2E_PROBES=1, by path; writes what it
// saw to $PROBE_OUT/<agent>.json, and with PROBE_PART=variants or trailing to
// <agent>-<part>.json. The decoders' fixtures (harnesses/*/fixtures/shell.probe.json) are
// samples of these files' raw session lines.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "../../testing/probes.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate, text } from "../model/script.js"
import { start } from "../scenarios.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const part = process.env.PROBE_PART
const paste = (words: string) => `\x1b[200~${words.replace(/\n/g, "\r")}\x1b[201~`

/** A session file's end, each line cut to 3000 characters so long output cannot crowd out the rest. */
const capped = (content: string): string =>
  content
    .split("\n")
    .map((line) => line.slice(0, 3000))
    .join("\n")
    .slice(-40_000)

/** Every file under `dir` changed since `since`, newest last, for the raw transcripts. */
const changed = (dir: string, since: number): string[] => {
  if (!existsSync(dir)) return []
  const found: string[] = []
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (stat.mtimeMs >= since && /\.(jsonl|json|pb)$/.test(name)) found.push(path)
    }
  }
  walk(dir)
  return found
}

for (const setup of setups) {
  describe.skipIf(!supported)(`probe: ! commands in ${setup.name}`, () => {
    const it = e2e(setup)
    it("pasted, typed, multi-line, and mid-turn", async ({ e2e: run }) => {
      const held = gate()
      const again = gate()
      run.model.use(
        async (call) => {
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Held." }
        },
        async (call) => {
          if (!asked(call, "Hold again")) return undefined
          await again.opened
          return { text: "Held again." }
        },
        (call) => (asked(call, "After bang") ? { text: "After." } : undefined),
      )
      const began = Date.now()
      const t = await start(run, setup)
      const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
      const out: Record<string, unknown> = {}
      const file = (name: string) => existsSync(join(run.sandbox.project, name))
      const look = async (label: string) => {
        out[label] = {
          screen: screenRecord(await t.screen()),
          activity: t.summary().agent,
        }
      }
      const calls = () => run.model.mark()

      // 8. A command ending in `$NAME` or `@name`, where a prompt's picker would open.
      const trailing = async (): Promise<void> => {
        for (const [label, words, made] of [
          ["8-dollar", "touch dollar.txt; echo $HOME", "dollar.txt"],
          ["8-at", "touch at.txt; echo @src", "at.txt"],
          ["8-at-bare", "touch atbare.txt; echo @", "atbare.txt"],
          ["8-dollar-bare", "touch dollarbare.txt; echo $", "dollarbare.txt"],
        ] as const) {
          raw("!")
          await sleep(800)
          raw(paste(words))
          await sleep(1500)
          await look(`${label}-pasted`)
          raw("\r")
          await sleep(3000)
          await look(`${label}-entered`)
          out[`${label}-file`] = file(made)
          // Whatever a picker left, gone before the next.
          raw("\x1b")
          await sleep(600)
          raw("\x15")
          await sleep(600)
        }
        const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${setup.agent}-trailing.json`), JSON.stringify(out, null, 2))
      }

      // 9. Other outcomes: stderr, a non-zero exit, long output, and Esc on a running command.
      const variants = async (): Promise<void> => {
        for (const [label, words] of [
          ["9-stderr", "echo out-line; echo err-line >&2"],
          ["9-fail", "echo before; exit 3"],
          ["9-missing", "no-such-command-here"],
          ["9-long", "seq 1 4000"],
          ["9-multiline", "echo first\necho second"],
          ["9-sleep", "echo started; sleep 30"],
        ] as const) {
          raw(paste(`!${words}`))
          await sleep(800)
          raw("\r")
          await sleep(label === "9-sleep" ? 2000 : 3500)
          await look(`${label}-entered`)
          if (label === "9-sleep") {
            raw("\x1b")
            await sleep(3000)
            await look(`${label}-escaped`)
          }
        }
        const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
        mkdirSync(dir, { recursive: true })
        out.raw = changed(run.sandbox.home, began).map((path) => ({
          path: path.slice(run.sandbox.home.length),
          tail: capped(readFileSync(path, "utf8")),
        }))
        writeFileSync(join(dir, `${setup.agent}-variants.json`), JSON.stringify(out, null, 2))
      }

      // 9. Leaving shell mode: Backspace on the lone `!`, idle and mid-turn; and what each
      // footer shows in and out of it.
      const undo = async (): Promise<void> => {
        await look("9-idle")
        raw("!")
        await sleep(800)
        await look("9-bang")
        raw("\x7f")
        await sleep(800)
        await look("9-backspaced")
        // Typed text after the Backspace is an ordinary prompt again.
        raw(paste("touch undo-normal.txt"))
        await sleep(1000)
        await look("9-normal-pasted")
        raw("\x15")
        await sleep(600)
        await look("9-cleared")
        await t.submit("Hold on")
        await sleep(2500)
        await look("9-working")
        raw("!")
        await sleep(800)
        await look("9-working-bang")
        raw("\x7f")
        await sleep(800)
        await look("9-working-backspaced")
        held.open()
        await t.until("Held.", 30_000).catch(() => undefined)
        await sleep(1500)
        await look("9-after")
        out["9-normal-file"] = file("undo-normal.txt")
        const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${setup.agent}-undo.json`), JSON.stringify(out, null, 2))
      }
      if (part === "undo") return await undo()
      if (part === "trailing") return await trailing()
      if (part === "variants") return await variants()
      // 1. The whole prompt as one paste at an idle prompt.
      let mark = calls()
      raw(paste("!echo bang-one > one.txt"))
      await sleep(1200)
      await look("1-pasted")
      raw("\r")
      await sleep(4000)
      await look("1-entered")
      out["1-file"] = file("one.txt")
      out["1-calls"] = calls() - mark

      // 2. `!` typed alone, then the rest pasted.
      mark = calls()
      raw("!")
      await sleep(800)
      await look("2-bang")
      raw(paste("echo bang-two > two.txt"))
      await sleep(1200)
      await look("2-pasted")
      raw("\r")
      await sleep(4000)
      await look("2-entered")
      out["2-file"] = file("two.txt")
      out["2-calls"] = calls() - mark

      // 3. Two lines in one paste.
      raw(paste("!echo a > m1.txt\necho b > m2.txt"))
      await sleep(1200)
      await look("3-pasted")
      raw("\r")
      await sleep(4000)
      await look("3-entered")
      out["3-files"] = { m1: file("m1.txt"), m2: file("m2.txt") }

      // 4. While a turn works.
      await t.submit("Hold on")
      await sleep(2500)
      await look("4-working")
      raw(paste("!echo bang-three > three.txt"))
      await sleep(1200)
      await look("4-pasted")
      raw("\r")
      await sleep(4000)
      await look("4-entered")
      out["4-file-before-turn-ends"] = file("three.txt")
      held.open()
      await t.until("Held.", 30_000).catch(() => undefined)
      await sleep(3000)
      await look("4-after")
      out["4-file-after"] = file("three.txt")

      // 6. `!` typed alone, then two lines pasted.
      await look("6-idle")
      raw("!")
      await sleep(800)
      raw(paste("echo c > m3.txt\necho d > m4.txt"))
      await sleep(1200)
      await look("6-pasted")
      raw("\r")
      await sleep(4000)
      await look("6-entered")
      out["6-files"] = { m3: file("m3.txt"), m4: file("m4.txt") }

      // 7. `!` typed alone while a turn works, then the rest pasted.
      await t.submit("Hold again")
      await sleep(2500)
      raw("!")
      await sleep(800)
      await look("7-bang")
      raw(paste("echo bang-four > four.txt"))
      await sleep(1200)
      await look("7-pasted")
      raw("\r")
      await sleep(4000)
      await look("7-entered")
      out["7-file-before-turn-ends"] = file("four.txt")
      again.open()
      await t.until("Held again.", 30_000).catch(() => undefined)
      await sleep(3000)
      await look("7-after")
      out["7-file-after"] = file("four.txt")

      // 5. What the model hears next.
      mark = calls()
      await t.submit("After bang")
      await t.until("After.", 30_000).catch(() => undefined)
      const last = run.model.calls.at(-1)
      out["5-model-heard"] = last ? text(last).slice(-3000) : null
      out["5-calls"] = calls() - mark

      out.transcript = await t.transcript()
      out.raw = changed(run.sandbox.home, began).map((path) => ({
        path: path.slice(run.sandbox.home.length),
        tail: capped(readFileSync(path, "utf8")),
      }))
      const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${setup.agent}.json`), JSON.stringify(out, null, 2))
    })
  })
}
