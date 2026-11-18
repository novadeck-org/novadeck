import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool } from "./model/script.js"
import { own, result, start, through } from "./scenarios.js"

// An agent's show of a PDF it wrote (docs/agent-workspace.md): through Novadeck's MCP `show`,
// as a video is, the item is a PDF whose bytes the pane reads in parts. The same for every
// harness (see messaging.e2e.ts for the rule on parity). The model here is a script, so this
// checks that each harness's call reaches Novadeck as a PDF, not what a real model would show.

// Bytes standing in for a written PDF: the runner tells one by its extension, and the pane,
// not the runner, reads what it holds.
const report = Buffer.from("%PDF-1.4 novadeck-e2e report")
const file = "report.pdf"

/** The model's turn: it shows the PDF, then says so. */
const rules = [
  own((call) => {
    const show = tool(call, "show")
    return show && asked(call, "Show the report")
      ? { calls: [{ name: show, input: { file: { path: file }, open: true } }] }
      : undefined
  }),
  own((call) => ((result(call) ?? "").includes(file) ? { text: "Showing it." } : undefined)),
]

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("shows a PDF it wrote, its bytes read in parts", async ({ e2e: run }) => {
      writeFileSync(join(run.sandbox.project, file), report)
      run.model.use(...rules)
      const t = await start(run, setup)
      const mark = t.mark()

      await t.submit("Show the report")
      await t.until("Showing it.")
      await through(t, ["settled"], { after: mark })

      const shown = run.deck.items.bar(t.id).filter((each) => each.name === file)
      expect(shown).toMatchObject([
        { kind: "pdf", by: "agent", openAsked: true, from: { terminalId: t.id, handle: t.handle } },
      ])
      const itemId = shown[0]!.id
      const content = await run.deck.items.load(itemId, false)
      expect(content).toMatchObject({
        state: "ready",
        content: { kind: "pdf", size: report.length },
      })
      const stamp = content.state === "ready" ? content.stamp : ""
      await expect(run.deck.items.part({ itemId, stamp, offset: 0 })).resolves.toEqual({
        state: "part",
        data: report.toString("base64"),
      })
    })
  })
}
