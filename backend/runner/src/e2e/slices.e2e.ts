/* eslint-disable no-await-in-loop -- A scenario's steps run in order, each after the one before. */
import type { SliceChange } from "@novadeck/protocol"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { answers, lacking, start } from "./scenarios.js"

// The live slice against each real harness: what it draws at its input shows as rows of its
// screen, whichever side of its box it draws on, and goes when it closes. With
// `NOVADECK_E2E_HARNESS=latest` this is what tells of a harness that moved what it draws.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const rows = (change: SliceChange | undefined): string =>
  change?.slice?.rows.map((row) => row.map(({ text }) => text).join("")).join("\n") ?? ""

// The rows with their styles: a harness that marks its selected row by colour alone (opencode's
// menus) moves the mark with no change of text.
const styled = (change: SliceChange | undefined): string =>
  JSON.stringify(change?.slice?.rows ?? [])

for (const setup of setups) {
  describe.skipIf(!supported)(`live slice of ${setup.name}`, () => {
    const it = e2e(setup)
    it("shows a menu and a command's view, and clears with them", async ({ e2e: run }) => {
      const view = setup.view ?? "/permissions"
      run.model.use(() => undefined)
      const t = await start(run, setup)
      const { terminals } = run.deck
      const keys = (data: string) => terminals.write({ terminalId: t.id, data }, "e2e")
      const seen: SliceChange[] = []
      const controller = new AbortController()
      const reading = (async () => {
        for await (const change of terminals.slice(t.id, controller.signal)) seen.push(change)
      })()
      const until = async (what: string, met: (latest: SliceChange | undefined) => boolean) => {
        for (let waited = 0; waited < 150; waited += 1) {
          if (met(seen.at(-1))) return
          await sleep(100)
        }
        throw new Error(`The slice never showed ${what}. Its screen:\n${await t.screen()}`)
      }
      // The screen at rest goes first: a menu is told against it.
      await sleep(500)
      keys("/")
      await until("the / menu", (latest) => latest?.slice?.reason === "menu")
      const menu = rows(seen.at(-1))
      const marked = styled(seen.at(-1))
      expect(menu).toMatch(/\/[a-z-]+/)
      expect(seen.at(-1)?.slice?.columns).toBe(terminals.get(t.id).cols)
      keys("\x1b[B")
      await until("the mark move", (latest) => styled(latest) !== marked)
      // Backspacing the key closes its menu on every harness; pi's Ctrl-U leaves it open.
      keys("\x7f")
      await until("the menu close", (latest) => latest?.slice === null)
      await sleep(300)
      keys(view)
      // Its rows name the command, with its `/` or without (pi's list `→ settings`).
      const named = (latest: SliceChange | undefined) => rows(latest).includes(view.slice(1))
      await until("the filtered menu", named)
      await sleep(300)
      keys("\r")
      await until("the command's view", (latest) => latest?.slice?.reason === "view")
      keys("\x1b")
      await until("the view close", (latest) => latest?.slice === null)
      await sleep(300)

      // As the chat does: the person's keys through `agents.keys`, Enter on its own.
      const pass = (data: string) => terminals.keys({ terminalId: t.id, keys: data })
      for (const key of view.slice(0, 5)) {
        pass(key)
        await sleep(90)
      }
      await until("the menu, by keys", named)
      pass("\x1b[B")
      await sleep(300)
      pass("\x1b[A")
      await sleep(300)
      pass("\x7f\x7f\x7f\x7f")
      await sleep(300)
      for (const key of view.slice(1, 5)) {
        pass(key)
        await sleep(90)
      }
      await sleep(400)
      pass("\r")
      // Antigravity completes the row into its box, and takes a second Enter to run it.
      for (let waited = 0; waited < 30; waited += 1) {
        if (seen.at(-1)?.slice?.reason === "view") break
        await sleep(100)
      }
      if (seen.at(-1)?.slice?.reason !== "view") pass("\r")
      await until("the view, by keys", (latest) => latest?.slice?.reason === "view")
      pass("\x1b")
      await until("the view close, by keys", (latest) => latest?.slice === null)
      await sleep(300)

      // A mention: the words before it go as they are, and the menu comes up behind them.
      if (lacking(setup, "mention") === undefined) {
        pass("look at @")
        await until("the @ menu", (latest) => latest?.slice?.reason === "menu")
        pass("\x15")
        await until("the @ menu close", (latest) => latest?.slice === null)
      }
      controller.abort()
      await reading
    })

    gated(it, lacking(setup, "approval"))(
      "leaves a dialog the chat answers to the chat",
      async ({ e2e: run }) => {
        const { approval } = setup
        run.model.use(answers("Make the file", (call) => approval!.request(call)))
        const t = await start(run, setup)
        const { terminals } = run.deck
        await t.submit("Make the file")
        await t.until(approval!.shows)
        for (let waited = 0; waited < 100; waited += 1) {
          if ((await t.detail()).requests.length > 0) break
          await sleep(100)
        }
        expect(() => terminals.keys({ terminalId: t.id, keys: "/" })).toThrow(/waits on the person/)
      },
    )
  })
}
