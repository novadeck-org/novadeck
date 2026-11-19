import type { FilePart, ItemContent, ModelFormat } from "@novadeck/core/items"

import { cannot, studio, type SampleArtifact } from "./artifacts"
import { arm, armWith, bracket, crate, emptyStl, notAModel, scan, spacer } from "./model"

// The 3D models an agent shows: a bracket a CAD loop writes, an arm with its buffer beside it
// and an animation, a crate with its materials and a scan of points, drawn at once; and one
// read slowly, one too large, one held as secret, one whose read fails, one naming a texture at
// an address of its own, one compressed with Draco, and one that isn't a model, so each state of
// the 3D pane can be reached.
const modelItem = (
  id: string,
  name: string,
  detail: string,
  secret = false,
): SampleArtifact["item"] => ({
  id,
  kind: "model",
  name,
  detail,
  path: `${studio}/${secret ? ".private/" : "parts/"}${name}`,
  url: null,
  lines: null,
  secret,
})

type Beside = { readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> }

// What a model holds: its format and size, and the files beside it, from the stamp it is read at.
export const modelContent = (
  format: ModelFormat,
  size: number,
  files: readonly Beside[] = [],
  refused: readonly {
    name: string
    reason: "external" | "outside" | "secret" | "missing" | "too-large"
  }[] = [],
  stamp = "1",
): ItemContent => ({
  state: "ready",
  stamp,
  content: {
    kind: "model",
    format,
    size,
    files: files.map(({ name, bytes }) => ({ name, size: bytes.length, stamp })),
    refused,
  },
})

// The files beside a model, read as the runner reads them: in parts of `part` bytes (its 2 MiB
// unless given), each `delay` ms, and only those the model names. They're read here, in the
// samples that load with a model, not in the demo's simulation, which loads with the demo.
const besideOf =
  (files: readonly Beside[], { part = 2 * 1024 * 1024, delay = 0 } = {}) =>
  async (name: string, offset: number): Promise<FilePart> => {
    const bytes = files.find((file) => file.name === name)?.bytes
    if (!bytes) throw new Error("That file isn't one the model names")
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    return { state: "part", bytes: bytes.slice(offset, offset + part) }
  }

const armFiles = (): { gltf: Uint8Array<ArrayBuffer>; files: Beside[] } => {
  const { gltf, bin } = arm()
  return { gltf, files: [{ name: "arm.bin", bytes: bin }] }
}

const bracketSample = (length: number, stamp = "1"): SampleArtifact => {
  const bytes = bracket(length)
  return {
    item: modelItem("studio-bracket", "bracket.stl", "STL, CAD output"),
    content: modelContent("stl", bytes.length, [], [], stamp),
    file: { read: async () => bytes },
  }
}

/** The bracket again, as the CAD loop rewrote it longer: a new stamp, read in small parts. */
export const bracketAgain = (stamp: string, length: number): SampleArtifact => {
  const sample = bracketSample(length, stamp)
  return { ...sample, file: { ...sample.file!, part: 2048, delay: 200 } }
}

const armSample = (): SampleArtifact => {
  const { gltf, files } = armFiles()
  return {
    item: modelItem("studio-arm", "arm.gltf", "glTF, animated"),
    content: modelContent("gltf", gltf.length, files),
    file: { read: async () => gltf, beside: besideOf(files) },
  }
}

const crateSample = (): SampleArtifact => {
  const { obj, mtl } = crate()
  const files = [{ name: "crate.mtl", bytes: mtl }]
  return {
    item: modelItem("studio-crate", "crate.obj", "OBJ with materials"),
    content: modelContent("obj", obj.length, files),
    file: { read: async () => obj, beside: besideOf(files) },
  }
}

const scanBytes = scan()
const spacerBytes = spacer()
// The arm, claiming a buffer of 4 GB, which it doesn't hold.
const claimingArm = armWith({ buffers: [{ uri: "arm.bin", byteLength: 4_000_000_000 }] })
const { files: armBeside } = armFiles()
const outsideArm = armWith({
  images: [{ uri: "https://cdn.example.com/arm-skin.png" }],
  textures: [{ source: 0 }],
})
const dracoArm = armWith({
  extensionsUsed: ["KHR_draco_mesh_compression"],
  extensionsRequired: ["KHR_draco_mesh_compression"],
})

export const modelSamples = {
  bracket: bracketSample(60),
  arm: armSample(),
  crate: crateSample(),
  scan: {
    item: modelItem("studio-scan", "dome-scan.ply", "PLY, 1,800 points"),
    content: modelContent("ply", scanBytes.length),
    file: { read: async () => scanBytes },
  },
  // Parts of 1 KB, 300 ms each: its progress shows.
  slow: {
    item: modelItem("studio-arm-slow", "slow-arm.gltf", "glTF, animated"),
    content: modelContent("gltf", arm().gltf.length, armBeside),
    file: {
      read: async () => arm().gltf,
      beside: besideOf(armBeside, { part: 1024, delay: 300 }),
      part: 1024,
      delay: 300,
    },
  },
  large: {
    item: modelItem("studio-hull", "hull-scan.glb", "glTF, 2.4 M triangles"),
    content: cannot("too-large", 410 * 1024 * 1024),
  },
  secret: {
    item: modelItem("studio-prototype", "prototype.stl", "STL, unreleased", true),
    content: modelContent("stl", bracket(80).length),
    file: { read: async () => bracket(80) },
  },
  // Its read fails, as when the link to the runner drops.
  failing: {
    item: modelItem("studio-bracket-failing", "unreachable-bracket.stl", "STL, CAD output"),
    content: modelContent("stl", bracket(60).length),
    file: { read: async () => bracket(60), fails: true },
  },
  // A texture at an address of its own, which the runner refuses: drawn without it.
  outside: {
    item: modelItem("studio-arm-outside", "arm-skinned.gltf", "glTF, external texture"),
    content: modelContent("gltf", outsideArm.length, armBeside, [
      { name: "https://cdn.example.com/arm-skin.png", reason: "external" },
    ]),
    file: { read: async () => outsideArm, beside: besideOf(armBeside) },
  },
  draco: {
    item: modelItem("studio-arm-draco", "arm-draco.gltf", "glTF, Draco"),
    content: modelContent("gltf", dracoArm.length, armBeside),
    file: { read: async () => dracoArm, beside: besideOf(armBeside) },
  },
  threeMf: {
    item: modelItem("studio-spacer", "spacer.3mf", "3MF, millimetres"),
    content: modelContent("3mf", spacerBytes.length),
    file: { read: async () => spacerBytes },
  },
  // The files it names refused for each reason the runner gives, the model drawn without them.
  refusals: {
    item: modelItem("studio-arm-refusals", "arm-refused.gltf", "glTF, files refused"),
    content: modelContent("gltf", outsideArm.length, armBeside, [
      { name: "https://cdn.example.com/arm-skin.png", reason: "external" },
      { name: "../../shared/steel.png", reason: "outside" },
      { name: ".env", reason: "secret" },
      { name: "normals.png", reason: "missing" },
      { name: "scan-8k.png", reason: "too-large" },
    ]),
    file: { read: async () => outsideArm, beside: besideOf(armBeside) },
  },
  // Its buffer is listed, but reading it fails, as when the link drops between parts.
  besideFails: {
    item: modelItem("studio-arm-unread", "arm-unread.gltf", "glTF, buffer unread"),
    content: modelContent("gltf", arm().gltf.length, armBeside),
    file: {
      read: async () => arm().gltf,
      beside: () => Promise.reject(new Error("The link to the runner dropped")),
    },
  },
  claims: {
    item: modelItem("studio-arm-claims", "arm-claims.gltf", "glTF, 4 GB claimed"),
    content: modelContent("gltf", claimingArm.length, armBeside),
    file: { read: async () => claimingArm, beside: besideOf(armBeside) },
  },
  empty: {
    item: modelItem("studio-empty", "empty.stl", "STL, nothing in it"),
    content: modelContent("stl", emptyStl.length),
    file: { read: async () => emptyStl },
  },
  // Past what a peek reads for a still (32 MB with its files), as the runner gives its size: the
  // peek shows its badge, and the pane draws the bracket.
  pastPeek: {
    item: modelItem("studio-bracket-large", "bracket-fine.stl", "STL, fine mesh"),
    content: modelContent("stl", 40 * 1024 * 1024),
    file: { read: async () => bracket(60) },
  },
  broken: {
    item: modelItem("studio-broken", "broken.glb", "Not a model"),
    content: modelContent("glb", notAModel.length),
    file: { read: async () => notAModel },
  },
} satisfies Record<string, SampleArtifact>
