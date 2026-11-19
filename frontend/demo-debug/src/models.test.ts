import { itemIdOf, type Item, type ItemContent } from "@novadeck/core/items"
import type { BackendAction } from "@novadeck/core/port"
import type { TerminalKey } from "@novadeck/core/types"
import { createShowcase } from "@novadeck/demo/showcase/simulation"

import { modelGroups } from "./models"
import { describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"

const key: TerminalKey = { projectId: "p", workspaceSessionId: "s", terminalId: "01" }

// The group's actions over a showcase, which reports what it shows as a session would.
const panel = () => {
  const showcase = createShowcase({ agents: [] })
  const reported: Item[] = []
  showcase.start(
    (actions: readonly BackendAction[]) => {
      for (const action of actions) if (action.type === "item/upsert") reported.push(action.item)
    },
    () => reported,
  )
  const notes: string[] = []
  const [group] = modelGroups(showcase)
  const run = (label: string, selected: TerminalKey | null = key) =>
    void group!.actions
      .find((action) => action.label === label)!
      .run({
        selected: () => selected ?? undefined,
        workspace: () => undefined,
        note: (text: string) => notes.push(text),
      } as unknown as DemoActionContext)
  const content = (id: string) => {
    let seen: ItemContent | undefined
    showcase.follow(key, itemIdOf(id), { reveal: undefined }, (next) => (seen = next))()
    return seen
  }
  const read = (
    id: string,
    options: { reveal?: string | undefined; file?: string; stamp?: string } = {},
  ) =>
    showcase.part!(key, itemIdOf(id), {
      stamp: options.stamp ?? "1",
      offset: 0,
      reveal: options.reveal,
      ...(options.file !== undefined && { file: options.file }),
    })
  return { reported, notes, run, content, read }
}

describe("the debug panel's 3D model group", () => {
  it("is absent where the demo has no showcase", () => {
    expect(modelGroups(undefined)).toEqual([])
  })

  it("hints what each action shows", () => {
    const [group] = modelGroups(createShowcase({ agents: [] }))
    expect(group!.section).toBe("Agents")
    expect(group!.actions.map((action) => action.label)).toEqual([
      "Show an STL bracket",
      "Show an animated glTF",
      "Show an OBJ with materials",
      "Show a PLY scan of points",
      "Show a 3MF spacer",
      "Show a model that loads slowly",
      "Show a model too large to preview",
      "Show a model that may hold secrets",
      "Show a model whose read fails",
      "Show a glTF naming a texture elsewhere",
      "Show a glTF whose files were refused",
      "Show a glTF whose buffer can't be read",
      "Show a glTF claiming 4 GB",
      "Show an STL with nothing in it",
      "Show a model past what a peek draws",
      "Show a Draco-compressed glTF",
      "Show a file that isn't a model",
      "Stop the 3D viewer",
      "Rewrite the bracket",
    ])
    expect(group!.actions.every((action) => action.hint.length > 0)).toBe(true)
  })

  it("shows each model on the selected terminal's bar, with the files beside it it names", async () => {
    const { run, reported, content, read } = panel()
    run("Show an STL bracket")
    run("Show an animated glTF")
    run("Show a model too large to preview")
    expect(reported.map((item) => [item.kind, item.name])).toEqual([
      ["model", "bracket.stl"],
      ["model", "arm.gltf"],
      ["model", "hull-scan.glb"],
    ])
    const arm = content("studio-arm")
    expect(arm).toMatchObject({
      state: "ready",
      content: { kind: "model", format: "gltf", files: [{ name: "arm.bin" }] },
    })
    const gltf = await read("studio-arm")
    const json =
      gltf.state === "part"
        ? (JSON.parse(new TextDecoder().decode(gltf.bytes)) as {
            buffers: { uri: string; byteLength: number }[]
          })
        : undefined
    expect(json?.buffers[0]?.uri).toBe("arm.bin")
    const bin = await read("studio-arm", { file: "arm.bin" })
    expect(bin.state === "part" && bin.bytes.length).toBe(json?.buffers[0]?.byteLength)
    await expect(read("studio-arm", { file: ".env" })).rejects.toThrow("isn't one the model names")
    expect(content("studio-hull")).toMatchObject({ state: "unavailable", reason: "too-large" })
    const stl = await read("studio-bracket")
    // A binary STL: 84 bytes, then 50 for each triangle it counts.
    const bytes = stl.state === "part" ? stl.bytes : new Uint8Array()
    expect(bytes.length).toBe(
      84 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true) * 50,
    )
  })

  it("serves a 3MF as a zip, and fails reading a buffer that can't be read", async () => {
    const { run, read } = panel()
    run("Show a 3MF spacer")
    run("Show a glTF whose buffer can't be read")
    const zipped = await read("studio-spacer")
    expect(zipped.state === "part" && [...zipped.bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 3, 4])
    await expect(read("studio-arm-unread", { file: "arm.bin" })).rejects.toThrow("link")
  })

  it("names a texture elsewhere among what wasn't read", () => {
    const { run, content } = panel()
    run("Show a glTF naming a texture elsewhere")
    expect(content("studio-arm-outside")).toMatchObject({
      content: { refused: [{ name: "https://cdn.example.com/arm-skin.png", reason: "external" }] },
    })
  })

  it("holds the secret one back until revealed, and rewrites the bracket under a new stamp", async () => {
    const { run, reported, read, content } = panel()
    run("Show a model that may hold secrets")
    expect(await read("studio-prototype")).toEqual({ state: "unavailable", reason: "secret" })
    const path = reported.find((item) => item.secret)?.path ?? undefined
    expect((await read("studio-prototype", { reveal: path })).state).toBe("part")
    run("Show an STL bracket")
    run("Rewrite the bracket")
    const rewritten = content("studio-bracket")
    expect(rewritten?.state === "ready" && rewritten.stamp).toBe("rewritten-1")
    expect(await read("studio-bracket")).toEqual({ state: "changed" })
  })

  it("asks for a terminal first, and for a model before stopping its viewer", () => {
    const { run, notes, reported } = panel()
    run("Show an STL bracket", null)
    run("Stop the 3D viewer")
    expect(notes).toEqual(["Select a terminal first.", "Show a model first."])
    expect(reported).toEqual([])
  })
})
