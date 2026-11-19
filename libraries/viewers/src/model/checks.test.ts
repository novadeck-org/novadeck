import { strToU8, zipSync } from "three/addons/libs/fflate.module.js"
import { describe, expect, it } from "vitest"

import {
  claimLimits,
  glbJson,
  gltfImages,
  gltfTrouble,
  imageSize,
  imagesTrouble,
  pixelLimits,
  zipTrouble,
} from "./checks.js"

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

  it("is read as the unzipping reads it, whatever count it gives the disk", () => {
    // A directory that tells one entry where the unzipping reads five, each claiming 900 MB.
    const bytes = zipSync(
      Object.fromEntries(
        Array.from({ length: 5 }, (_, at) => [`3D/part${at}.model`, strToU8("<model/>")]),
      ),
    )
    const view = new DataView(bytes.buffer)
    let entry = 0
    for (let at = 0; at + 4 <= bytes.length; at += 1)
      if (view.getUint32(at, true) === 0x02014b50) {
        view.setUint16(at + 10, 8, true)
        view.setUint32(at + 24, 900 * 1024 * 1024, true)
        entry += 1
      }
    expect(entry).toBe(5)
    const end = bytes.length - 22
    view.setUint16(end + 10, 1, true)
    expect(zipTrouble(bytes.buffer as ArrayBuffer)).toBe("too-large")
  })

  it("is too large where it's a Zip64 one", () => {
    const zipped = zipSync({ "3D/3dmodel.model": strToU8("<model/>") })
    const locator = new Uint8Array(20)
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true)
    const end = zipped.length - 22
    const bytes = new Uint8Array(zipped.length + 20)
    bytes.set(zipped.subarray(0, end))
    bytes.set(locator, end)
    bytes.set(zipped.subarray(end), end + 20)
    expect(zipTrouble(bytes.buffer as ArrayBuffer)).toBe("too-large")
  })

  it("is unreadable where it's no zip", () => {
    expect(zipTrouble(strToU8("no zip here at all, none").buffer as ArrayBuffer)).toBe("unreadable")
  })
})

// An image's first bytes as each format writes its size.
const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x89504e47)
  view.setUint32(4, 0x0d0a1a0a)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}
const jpeg = (width: number, height: number) =>
  // Its start, an application segment of 16 bytes, then a frame's start.
  Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Array.from({ length: 14 }, () => 0),
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
  ])
const webp = (width: number, height: number) => {
  const bytes = new Uint8Array(30)
  bytes.set(strToU8("RIFF"), 0)
  bytes.set(strToU8("WEBPVP8X"), 8)
  const w = width - 1
  const h = height - 1
  bytes.set(
    [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff],
    24,
  )
  return bytes
}

describe("a model's images", () => {
  it("are sized as their headers claim", () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageSize(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(imageSize(webp(300, 200))).toEqual({ width: 300, height: 200 })
    expect(imageSize(strToU8("not an image"))).toBeUndefined()
  })

  it("are too large past what one, or all, may claim", () => {
    expect(imagesTrouble([png(1024, 1024), jpeg(2048, 2048)])).toBeNull()
    expect(imagesTrouble([png(16_384, 16_384)])).toBe("too-large")
    const many = Array.from({ length: pixelLimits.all / (8192 * 8192) + 1 }, () => webp(8192, 8192))
    expect(imagesTrouble(many)).toBe("too-large")
  })

  it("are found beside a glTF, in its data, and in a GLB's own buffer", () => {
    const beside = png(10, 10)
    const held = png(20, 20)
    const own = new Uint8Array(64)
    own.set(png(30, 30), 16)
    const json = {
      buffers: [{ byteLength: 64 }],
      bufferViews: [{ buffer: 0, byteOffset: 16, byteLength: 33 }],
      images: [
        { uri: "skin.png" },
        { uri: `data:image/png;base64,${btoa(String.fromCharCode(...held))}` },
        { bufferView: 0 },
      ],
    }
    const found = gltfImages(json, own, new Map([["skin.png", beside]])).map(imageSize)
    expect(found).toEqual([
      { width: 10, height: 10 },
      { width: 20, height: 20 },
      { width: 30, height: 30 },
    ])
  })
})
