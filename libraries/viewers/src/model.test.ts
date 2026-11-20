import "./model.css"
import { strToU8, zipSync } from "three/addons/libs/fflate.module.js"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { userEvent } from "vitest/browser"

import frameHtml from "./frame/frame.html?raw"
import type { ViewerState } from "./index.js"
import {
  modelStills,
  mountModel,
  type ModelContent,
  type ModelFrame,
  type ModelTrouble,
  type ModelViewer,
} from "./model.js"
// eslint-disable-next-line import/default -- The bundle's text, as the frame plugin gives it.
import modelCode from "./model/frame-entry.ts?frame"

// The frame's page, as the app serves it, and the viewer's code as the app bundles it.
const frame: ModelFrame = {
  url: URL.createObjectURL(new Blob([frameHtml], { type: "text/html" })),
  code: async () => ({ scripts: [modelCode] }),
}

// A cube, as each format writes it.
const corners = [
  [0, 0, 0],
  [10, 0, 0],
  [10, 10, 0],
  [0, 10, 0],
  [0, 0, 10],
  [10, 0, 10],
  [10, 10, 10],
  [0, 10, 10],
]
const faces = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [3, 0, 4],
  [3, 4, 7],
]

const stl = (): Blob => {
  const bytes = new ArrayBuffer(84 + faces.length * 50)
  const view = new DataView(bytes)
  view.setUint32(80, faces.length, true)
  faces.forEach((face, at) => {
    face.forEach((corner, index) =>
      corners[corner]!.forEach((value, axis) =>
        view.setFloat32(84 + at * 50 + 12 + index * 12 + axis * 4, value, true),
      ),
    )
  })
  return new Blob([bytes])
}

const ply = (points = false): Blob =>
  new Blob([
    [
      "ply",
      "format ascii 1.0",
      `element vertex ${corners.length}`,
      "property float x",
      "property float y",
      "property float z",
      ...(points ? [] : [`element face ${faces.length}`, "property list uchar int vertex_indices"]),
      "end_header",
      ...corners.map((corner) => corner.join(" ")),
      ...(points ? [] : faces.map((face) => `3 ${face.join(" ")}`)),
      "",
    ].join("\n"),
  ])

const obj = (): Blob =>
  new Blob([
    [
      "mtllib mat/cube.mtl",
      ...corners.map((corner) => `v ${corner.join(" ")}`),
      "usemtl red",
      ...faces.map((face) => `f ${face.map((corner) => corner + 1).join(" ")}`),
      "",
    ].join("\n"),
  ])
const mtl = new Blob(["newmtl red\nKd 1 0 0\nmap_Kd tex.png\n"])

// A 1 × 1 red PNG.
const red = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
)

// A triangle's glTF: its positions in a buffer, and an image of the address given.
const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
const gltfJson = (buffer: string, image?: string, more: Record<string, unknown> = {}) => ({
  asset: { version: "2.0" },
  scenes: [{ nodes: [0] }],
  scene: 0,
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, ...(image ? { material: 0 } : {}) }] }],
  ...(image
    ? {
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        textures: [{ source: 0 }],
        images: [{ uri: image }],
      }
    : {}),
  buffers: [{ uri: buffer, byteLength: triangle.byteLength }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: triangle.byteLength }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
  ],
  ...more,
})
const json = (value: unknown): Blob => new Blob([JSON.stringify(value)])

const glb = (): Blob => {
  const body = gltfJson("")
  delete (body.buffers[0] as { uri?: string }).uri
  let text = JSON.stringify(body)
  while (text.length % 4) text += " "
  const head = new ArrayBuffer(20)
  const view = new DataView(head)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, 20 + text.length + 8 + triangle.byteLength, true)
  view.setUint32(12, text.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  const bin = new DataView(new ArrayBuffer(8))
  bin.setUint32(0, triangle.byteLength, true)
  bin.setUint32(4, 0x004e4942, true)
  return new Blob([head, text, bin, triangle])
}

const threeMf = (): Blob => {
  const vertices = corners.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("")
  const triangles = faces.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("")
  const zip = zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ),
    "3D/3dmodel.model": strToU8(
      `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`,
    ),
  })
  return new Blob([zip])
}

const content = (
  format: ModelContent["format"],
  bytes: Blob,
  files: ModelContent["files"] = [],
  refused: ModelContent["refused"] = [],
): ModelContent => ({ format, bytes, files, refused })

// What a still drew: its size, and how many of its pixels aren't see-through.
const drawn = async (still: Blob | null): Promise<{ size: number; inked: number } | null> => {
  if (!still) return null
  const bitmap = await createImageBitmap(still)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext("2d")!
  context.drawImage(bitmap, 0, 0)
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
  let inked = 0
  for (let at = 3; at < data.length; at += 4) if (data[at]! > 0) inked += 1
  return { size: bitmap.width, inked }
}

const panes: HTMLElement[] = []
const ends: (() => void)[] = []
afterEach(() => {
  for (const end of ends.splice(0)) end()
  for (const pane of panes.splice(0)) pane.remove()
})

const paneIn = (): HTMLElement => {
  const pane = document.createElement("div")
  pane.style.cssText = "display: flex; flex-direction: column; height: 300px; width: 400px"
  document.body.append(pane)
  panes.push(pane)
  return pane
}

const mount = (
  given: ModelContent,
  options: { saved?: ViewerState; onTrouble?: (trouble: ModelTrouble | null) => void } = {},
): ModelViewer & { pane: HTMLElement } => {
  const pane = paneIn()
  const viewer = mountModel(pane, { content: given, label: "cube", frame, ...options })
  ends.push(viewer.destroy)
  return Object.assign(viewer, { pane })
}

type View = { target: number[]; position: number[]; grid: boolean; wireframe: boolean }
const viewOf = (viewer: ModelViewer): View | undefined =>
  (viewer.state() as unknown as { model?: View }).model

describe("a model's still", () => {
  // One frame for all of them, as the app has.
  const stills = modelStills(document, frame)
  afterAll(stills.destroy)

  it.each([
    ["an STL", () => content("stl", stl())],
    ["a PLY", () => content("ply", ply())],
    // Eight points of two pixels each.
    ["a PLY of points", () => content("ply", ply(true)), 24],
    [
      "an OBJ with its materials",
      () =>
        content("obj", obj(), [
          { name: "mat/cube.mtl", bytes: mtl },
          { name: "mat/tex.png", bytes: new Blob([red]) },
        ]),
    ],
    [
      "a glTF with its buffer beside it",
      () =>
        content("gltf", json(gltfJson("tri.bin")), [
          { name: "tri.bin", bytes: new Blob([triangle]) },
        ]),
    ],
    ["a GLB", () => content("glb", glb())],
    ["a 3MF", () => content("3mf", threeMf())],
  ] as [string, () => ModelContent, number?][])("is drawn for %s", async (_, made, least = 200) => {
    const still = await drawn(await stills.still(made(), 128))
    expect(still?.size).toBe(128)
    expect(still!.inked).toBeGreaterThan(least)
  })

  it("is drawn for a glTF whose image is an address of its own, without it", async () => {
    const still = await drawn(
      await stills.still(
        content(
          "gltf",
          json(gltfJson("tri.bin", "https://example.invalid/skin.png")),
          [{ name: "tri.bin", bytes: new Blob([triangle]) }],
          [{ name: "https://example.invalid/skin.png", reason: "external" }],
        ),
        64,
      ),
    )
    expect(still!.inked).toBeGreaterThan(50)
  })

  it("tells whoever asked how long it waits its turn behind the stills before it", async () => {
    const heard: string[] = []
    const queued = (name: string) => () => {
      heard.push(`${name} waits`)
      return () => heard.push(`${name}'s turn`)
    }
    const first = stills.still(content("stl", stl()), 64, undefined, queued("first"))
    const second = stills.still(content("stl", stl()), 64, undefined, queued("second"))
    expect(heard).toEqual(["first waits", "second waits"])
    void first.then(() => heard.push("first drawn"))
    expect((await drawn(await second))!.inked).toBeGreaterThan(50)
    expect(heard).toEqual([
      "first waits",
      "second waits",
      "first's turn",
      "first drawn",
      "second's turn",
    ])
  })

  it("is none for what can't be drawn, and the next one is still drawn", async () => {
    expect(await stills.still(content("stl", new Blob(["solid nothing\nendsolid"])), 64)).toBeNull()
    expect(await stills.still(content("glb", new Blob(["not a model at all"])), 64)).toBeNull()
    expect((await drawn(await stills.still(content("stl", stl()), 64)))!.inked).toBeGreaterThan(50)
  })
})

describe("the 3D model viewer", () => {
  it("fits the model at first and says where its camera is", async () => {
    const viewer = mount(content("stl", stl()))
    await expect.poll(() => viewOf(viewer)).toBeDefined()
    const view = viewOf(viewer)!
    // Looking at the cube's middle, turned to Y up.
    expect(view.target.map((each) => Math.round(each))).toEqual([5, 5, -5])
    expect(view.grid).toBe(true)
  })

  it("opens where an earlier viewer of it was, and keeps it as the model is written again", async () => {
    const first = mount(content("stl", stl()))
    await expect.poll(() => viewOf(first)).toBeDefined()
    const glass = first.pane.querySelector<HTMLElement>(".model-glass")!
    // Turned by a drag that starts on the glass, and zoomed by the wheel over it.
    const before = viewOf(first)!
    await userEvent.hover(glass, { position: { x: 200, y: 150 } })
    const box = glass.getBoundingClientRect()
    glass.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 200,
        clientX: box.x + 100,
        clientY: box.y + 100,
        bubbles: true,
        cancelable: true,
      }),
    )
    await expect.poll(() => viewOf(first)!.position).not.toEqual(before.position)
    const turned = viewOf(first)!
    first.destroy()

    const again = mount(content("stl", stl()), {
      saved: { model: turned } as unknown as ViewerState,
    })
    await expect.poll(() => viewOf(again)).toEqual(turned)
    // Written again, larger: the camera stays where it was.
    again.update(content("stl", stl()))
    await new Promise((settled) => setTimeout(settled, 500))
    expect(viewOf(again)).toEqual(turned)
  })

  it.each([
    [
      "claims buffers past what it draws",
      "too-large",
      { buffers: [{ byteLength: 4_000_000_000 }] },
    ],
    [
      "claims an accessor past what it draws",
      "too-large",
      {
        accessors: [{ bufferView: 0, componentType: 5126, count: 2_000_000_000, type: "VEC3" }],
      },
    ],
    [
      "needs a decoder it isn't given",
      "unsupported",
      {
        extensionsUsed: ["KHR_draco_mesh_compression"],
        extensionsRequired: ["KHR_draco_mesh_compression"],
      },
    ],
  ] as const)("says why it doesn't draw a glTF that %s", async (_, trouble, more) => {
    const troubles: (ModelTrouble | null)[] = []
    mount(
      content("gltf", json(gltfJson("tri.bin", undefined, more)), [
        { name: "tri.bin", bytes: new Blob([triangle]) },
      ]),
      { onTrouble: (each) => troubles.push(each) },
    )
    await expect.poll(() => troubles).toContain(trouble)
  })

  it("says why it doesn't draw a glTF whose images claim more than it decodes", async () => {
    // Tiny files, each claiming 16384 × 16384 pixels, which decoding would allocate.
    const huge = new Uint8Array(33)
    const view = new DataView(huge.buffer)
    view.setUint32(0, 0x89504e47)
    view.setUint32(4, 0x0d0a1a0a)
    view.setUint32(16, 16_384)
    view.setUint32(20, 16_384)
    const troubles: (ModelTrouble | null)[] = []
    mount(
      content("gltf", json(gltfJson("tri.bin", "skin.png")), [
        { name: "tri.bin", bytes: new Blob([triangle]) },
        { name: "skin.png", bytes: new Blob([huge]) },
      ]),
      { onTrouble: (each) => troubles.push(each) },
    )
    await expect.poll(() => troubles).toContain("too-large")
  })

  it("says why it doesn't draw a glTF whose buffer is an address of its own", async () => {
    const troubles: (ModelTrouble | null)[] = []
    mount(
      content(
        "gltf",
        json(gltfJson("https://example.invalid/tri.bin")),
        [],
        [{ name: "https://example.invalid/tri.bin", reason: "external" }],
      ),
      { onTrouble: (each) => troubles.push(each) },
    )
    await expect.poll(() => troubles).toContain("unreadable")
  })
})
