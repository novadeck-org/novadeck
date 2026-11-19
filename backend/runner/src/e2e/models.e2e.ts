import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool } from "./model/script.js"
import { own, result, start, through } from "./scenarios.js"

// An agent's show of a 3D model it wrote (docs/agent-workspace.md): through Novadeck's MCP
// `show`, as a PDF is, the item is a model whose bytes the pane reads in parts, with the files
// beside it that it names, which are read by name. The same for every harness (see
// messaging.e2e.ts for the rule on parity). The model here is a script, so this checks that
// each harness's call reaches Novadeck as a model, not what a real model would show.

// A glTF that names a buffer and a texture beside it, and one that it doesn't name. The runner
// tells a model by its extension; the pane, not the runner, reads what each holds.
const file = "scene.gltf"
const bin = Buffer.from("novadeck-e2e buffer")
const texture = Buffer.from("novadeck-e2e texture")
const scene = Buffer.from(
  JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ uri: "scene.bin", byteLength: bin.length }],
    images: [{ uri: "tex/skin.png" }, { uri: "https://example.com/remote.png" }],
  }),
)

/** The model's turn: it shows the model, then says so. */
const rules = [
  own((call) => {
    const show = tool(call, "show")
    return show && asked(call, "Show the model")
      ? { calls: [{ name: show, input: { file: { path: file }, open: true } }] }
      : undefined
  }),
  own((call) => ((result(call) ?? "").includes(file) ? { text: "Showing it." } : undefined)),
]

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("shows a 3D model it wrote, with the files it names read by name", async ({ e2e: run }) => {
      const folder = run.sandbox.project
      writeFileSync(join(folder, file), scene)
      writeFileSync(join(folder, "scene.bin"), bin)
      mkdirSync(join(folder, "tex"))
      writeFileSync(join(folder, "tex", "skin.png"), texture)
      run.model.use(...rules)
      const t = await start(run, setup)
      const mark = t.mark()

      await t.submit("Show the model")
      await t.until("Showing it.")
      await through(t, ["settled"], { after: mark })

      const shown = run.deck.items.bar(t.id).filter((each) => each.name === file)
      expect(shown).toMatchObject([
        {
          kind: "model",
          by: "agent",
          openAsked: true,
          from: { terminalId: t.id, handle: t.handle },
        },
      ])
      const itemId = shown[0]!.id
      const content = await run.deck.items.load(itemId, false)
      expect(content).toMatchObject({
        state: "ready",
        content: {
          kind: "model",
          format: "gltf",
          size: scene.length,
          files: [
            { name: "scene.bin", size: bin.length },
            { name: "tex/skin.png", size: texture.length },
          ],
          refused: [{ name: "https://example.com/remote.png", reason: "external" }],
        },
      })
      if (content.state !== "ready" || content.content.kind !== "model") return
      const stamp = content.stamp
      await expect(run.deck.items.part({ itemId, stamp, offset: 0 })).resolves.toEqual({
        state: "part",
        data: scene.toString("base64"),
      })
      const [buffer, image] = content.content.files
      await expect(
        run.deck.items.part({ itemId, stamp: buffer!.stamp, offset: 0, file: "scene.bin" }),
      ).resolves.toEqual({ state: "part", data: bin.toString("base64") })
      await expect(
        run.deck.items.part({ itemId, stamp: image!.stamp, offset: 0, file: "tex/skin.png" }),
      ).resolves.toEqual({ state: "part", data: texture.toString("base64") })
    })
  })
}
