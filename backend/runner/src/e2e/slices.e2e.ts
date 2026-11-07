/* eslint-disable no-await-in-loop -- A scenario's steps run in order, each after the one before. */
import type { SliceChange } from "@novadeck/protocol"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { start } from "./scenarios.js"

// The live slice against each real harness: what it draws at its input shows as rows of its
// screen, whichever side of its box it draws on, and goes when it closes. With
// `NOVADECK_E2E_HARNESS=latest` this is what tells of a harness that moved what it draws.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const rows = (change: SliceChange | undefined): string =>
  change?.slice?.rows.map((row) => row.map(({ text }) => text).join("")).join("\n") ?? ""

for (const setup of setups) {
  describe.skipIf(!supported)(`live slice of ${setup.name}`, () => {
    const it = e2e(setup)
    it("shows a menu and a command's view, and clears with them", async ({ e2e: run }) => {
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
      expect(menu).toMatch(/\/[a-z-]+/)
      expect(seen.at(-1)?.slice?.columns).toBe(terminals.get(t.id).cols)
      keys("\x1b[B")
      await until("the mark move", (latest) => rows(latest) !== menu)
      keys("\x15")
      await until("the menu close", (latest) => latest?.slice === null)
      await sleep(300)
      keys("/permissions")
      await until("the filtered menu", (latest) => rows(latest).includes("/permissions"))
      await sleep(300)
      keys("\r")
      await until("the command's view", (latest) => latest?.slice?.reason === "view")
      keys("\x1b")
      await until("the view close", (latest) => latest?.slice === null)
      controller.abort()
      await reading
    })
  })
}
