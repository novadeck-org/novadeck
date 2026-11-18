import { strToU8, zipSync } from "three/addons/libs/fflate.module.js"
import { describe, expect, it } from "vitest"

import { claimLimits, glbJson, gltfTrouble, zipTrouble } from "./checks.js"

const accessor = (count: number, type = "VEC3") => ({ componentType: 5126, count, type })

describe("a glTF's claims", () => {
  it("pass for what a model may claim", () => {
    expect(gltfTrouble({ buffers: [{ byteLength: 36 }], accessors: [accessor(3)] })).toBeNull()
  })

  it("are too large past what one array, or all, may take", () => {
    expect(gltfTrouble({ buffers: [{ byteLength: claimLimits.one + 1 }] })).toBe("too-large")
    expect(gltfTrouble({ accessors: [accessor(2_000_000_000)] })).toBe("too-large")
    const third = Math.floor(claimLimits.one / 12)
    expect(gltfTrouble({ accessors: [accessor(third), accessor(third), accessor(third)] })).toBe(
      "too-large",
    )
    expect(gltfTrouble({ images: Array.from({ length: 1025 }, () => ({})) })).toBe("too-large")
  })

  it("are unreadable where a size or type isn't one", () => {
    expect(gltfTrouble({ buffers: [{ byteLength: -1 }] })).toBe("unreadable")
    expect(gltfTrouble({ accessors: [{ componentType: 1, count: 3, type: "VEC3" }] })).toBe(
      "unreadable",
    )
    expect(gltfTrouble({ accessors: [{ ...accessor(3), sparse: { count: 4 } }] })).toBe(
      "unreadable",
    )
    expect(gltfTrouble(undefined)).toBe("unreadable")
  })

  it("are unsupported where the model needs a decoder the frame doesn't carry", () => {
    for (const name of [
      "KHR_draco_mesh_compression",
      "EXT_meshopt_compression",
      "KHR_texture_basisu",
    ])
      expect(gltfTrouble({ extensionsUsed: [name] })).toBe("unsupported")
    expect(gltfTrouble({ extensionsUsed: ["KHR_materials_unlit"] })).toBeNull()
  })
})

describe("a GLB's JSON", () => {
  const glb = (json: string, length = json.length) => {
    const bytes = new Uint8Array(20 + json.length)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 0x46546c67, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, bytes.length, true)
    view.setUint32(12, length, true)
    view.setUint32(16, 0x4e4f534a, true)
    bytes.set(strToU8(json), 20)
    return bytes.buffer
  }

  it("is read from its first chunk", () => {
    expect(glbJson(glb('{"asset":{}}'))).toEqual({ asset: {} })
  })

  it("is none for a chunk longer than the file, or no GLB", () => {
    expect(glbJson(glb('{"asset":{}}', 1_000_000))).toBeUndefined()
    expect(glbJson(strToU8("not a model at all, no").buffer as ArrayBuffer)).toBeUndefined()
  })
})

describe("a 3MF's zip", () => {
  const zip = () => zipSync({ "3D/3dmodel.model": strToU8("<model/>") })

  it("passes for what it may hold", () => {
    expect(zipTrouble(zip().buffer as ArrayBuffer)).toBeNull()
  })

  it("is too large where its directory claims past what it may hold", () => {
    const bytes = zip()
    const view = new DataView(bytes.buffer)
    // The central directory's entry: its size, as the unzipping takes it.
    const entry = bytes.findIndex(
      (_, at) => at + 4 <= bytes.length && view.getUint32(at, true) === 0x02014b50,
    )
    view.setUint32(entry + 24, 0xfffffff0, true)
    expect(zipTrouble(bytes.buffer as ArrayBuffer)).toBe("too-large")
  })

  it("is unreadable where it's no zip", () => {
    expect(zipTrouble(strToU8("no zip here at all, none").buffer as ArrayBuffer)).toBe("unreadable")
  })
})
