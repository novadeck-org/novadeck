import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool } from "./model/script.js"
import { own, result, start, through } from "./scenarios.js"

// An agent's show of a video it rendered (docs/agent-workspace.md): through Novadeck's MCP
// `show`, as an image or a file is, the item is a video that starts at the second the show
// gave, and the pane reads its bytes in parts. The same for every harness (see
// messaging.e2e.ts for the rule on parity). The model here is a script, so this checks that
// each harness passes `file.at` through to Novadeck, not what a real model would show.

// Bytes standing in for a rendered clip: the runner reads a video by its extension, never
// its frames.
const clip = Buffer.from("novadeck-e2e video frames")

const rules = [
  own((call) => {
    const show = tool(call, "show")
    return show && asked(call, "Show the demo")
      ? { calls: [{ name: show, input: { file: { path: "demo.webm", at: 2 }, open: true } }] }
      : undefined
  }),
  own((call) => ((result(call) ?? "").includes("demo.webm") ? { text: "Showing it." } : undefined)),
]

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("shows a video it rendered, from the second it names", async ({ e2e: run }) => {
      writeFileSync(join(run.sandbox.project, "demo.webm"), clip)
      run.model.use(...rules)
      const t = await start(run, setup)
      const mark = t.mark()

      await t.submit("Show the demo")
      await t.until("Showing it.")
      await through(t, ["settled"], { after: mark })

      const shown = run.deck.items.bar(t.id).filter((each) => each.name === "demo.webm")
      expect(shown).toMatchObject([
        {
          kind: "video",
          by: "agent",
          openAsked: true,
          from: { terminalId: t.id, handle: t.handle },
        },
      ])
      const itemId = shown[0]!.id
      const content = await run.deck.items.load(itemId, false)
      expect(content).toMatchObject({
        state: "ready",
        content: { kind: "video", mime: "video/webm", size: clip.length, shown: 1, at: 2 },
      })
      const stamp = content.state === "ready" ? content.stamp : ""
      await expect(run.deck.items.videoPart({ itemId, stamp, offset: 0 })).resolves.toEqual({
        state: "part",
        data: clip.toString("base64"),
      })
    })
  })
}
