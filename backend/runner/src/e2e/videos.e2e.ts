import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool } from "./model/script.js"
import { own, result, start, through } from "./scenarios.js"

// An agent's show of a video or a recording it rendered (dev-docs/agent-workspace.md): through
// Novadeck's MCP `show`, as an image or a file is, the item is a video or a recording that
// starts at the second the show gave, and the pane reads its bytes in parts. The same for
// every harness (see messaging.e2e.ts for the rule on parity). The model here is a script, so this checks that
// each harness passes `file.at` through to Novadeck, not what a real model would show.

// Bytes standing in for a rendered file: the runner tells a video or a recording by its
// extension, never by what it holds.
const clip = Buffer.from("novadeck-e2e rendered bytes")

const played = [
  { file: "demo.webm", kind: "video", mime: "video/webm", what: "a video" },
  { file: "voiceover.mp3", kind: "audio", mime: "audio/mpeg", what: "a recording" },
] as const

/** The model's turn: it shows `file` from its second second, then says so. */
const rules = (file: string) => [
  own((call) => {
    const show = tool(call, "show")
    return show && asked(call, "Show the render")
      ? { calls: [{ name: show, input: { file: { path: file, at: 2 }, open: true } }] }
      : undefined
  }),
  own((call) => ((result(call) ?? "").includes(file) ? { text: "Showing it." } : undefined)),
]

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it.for(played)(
      "shows $what it rendered, from the second it names",
      async ({ file, kind, mime }, { e2e: run }) => {
        writeFileSync(join(run.sandbox.project, file), clip)
        run.model.use(...rules(file))
        const t = await start(run, setup)
        const mark = t.mark()

        await t.submit("Show the render")
        await t.until("Showing it.")
        await through(t, ["settled"], { after: mark })

        const shown = run.deck.items.bar(t.id).filter((each) => each.name === file)
        expect(shown).toMatchObject([
          {
            kind,
            by: "agent",
            openAsked: true,
            from: { terminalId: t.id, handle: t.handle },
          },
        ])
        const itemId = shown[0]!.id
        const content = await run.deck.items.load(itemId, false)
        expect(content).toMatchObject({
          state: "ready",
          content: { kind, mime, size: clip.length, shown: 1, at: 2 },
        })
        const stamp = content.state === "ready" ? content.stamp : ""
        await expect(run.deck.items.part({ itemId, stamp, offset: 0 })).resolves.toEqual({
          state: "part",
          data: clip.toString("base64"),
        })
      },
    )
  })
}
