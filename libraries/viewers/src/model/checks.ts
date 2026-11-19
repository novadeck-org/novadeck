// What a model's file claims, checked before a loader believes it: a glTF's accessors and
// buffers, and a 3MF's zip entries, name sizes the loaders allocate as told, so a file that
// claims gigabytes would take the frame's memory with it. These run in the frame, before
// three.js reads the file; a file past them isn't drawn, and says why.

/** The most a model's arrays may claim in all, in bytes, and one array alone. */
export const claimLimits = { all: 1024 * 1024 * 1024, one: 512 * 1024 * 1024 } as const

/** The glTF extensions three.js needs a decoder for, which the frame doesn't carry. */
const needsDecoder = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_texture_basisu",
])

export type ClaimTrouble = "too-large" | "unsupported" | "unreadable"

const componentBytes: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
}
const componentsOf: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
}

type Json = Record<string, unknown>
const list = (value: unknown): Json[] =>
  Array.isArray(value)
    ? value.filter((each): each is Json => typeof each === "object" && !!each)
    : []
const count = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : Number.NaN

/** A GLB's JSON chunk, or undefined where it isn't one. */
export const glbJson = (bytes: ArrayBuffer): Json | undefined => {
  if (bytes.byteLength < 20) return undefined
  const view = new DataView(bytes)
  // "glTF", version 2, then the first chunk: its length and "JSON".
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) return undefined
  const length = view.getUint32(12, true)
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.byteLength) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length))) as Json
  } catch {
    return undefined
  }
}

/** Why a glTF's JSON can't be drawn as it claims, or null where it can. */
export const gltfTrouble = (json: Json | undefined): ClaimTrouble | null => {
  if (!json || typeof json !== "object") return "unreadable"
  const used = [json.extensionsUsed, json.extensionsRequired].flatMap((names) =>
    Array.isArray(names) ? names : [],
  )
  if (used.some((name) => needsDecoder.has(name as string))) return "unsupported"
  let all = 0
  for (const buffer of list(json.buffers)) {
    const length = count(buffer.byteLength)
    if (Number.isNaN(length)) return "unreadable"
    if (length > claimLimits.one) return "too-large"
    all += length
  }
  for (const accessor of list(json.accessors)) {
    const items = count(accessor.count)
    const size = componentBytes[accessor.componentType as number]
    const components = componentsOf[accessor.type as string]
    if (Number.isNaN(items) || !size || !components) return "unreadable"
    const bytes = items * size * components
    const sparse = accessor.sparse as Json | undefined
    const changed = sparse ? count(sparse.count) : 0
    if (Number.isNaN(changed) || changed > items) return "unreadable"
    if (bytes > claimLimits.one) return "too-large"
    all += bytes
  }
  if (all > claimLimits.all) return "too-large"
  if (list(json.images).length > 1024 || list(json.meshes).length > 65_536) return "too-large"
  return null
}

/**
 * Why a 3MF can't be read as it claims: the sizes its zip's central directory gives the entries
 * it deflates, which unzipping allocates as given, past `claimLimits.all` in all; or null where
 * it can. The directory is read exactly as the unzipping (fflate's `unzipSync`) reads it: its
 * count and place from the end record, and a Zip64 one, which no model the pane takes needs,
 * refused.
 */
export const zipTrouble = (bytes: ArrayBuffer): ClaimTrouble | null => {
  const view = new DataView(bytes)
  const length = bytes.byteLength
  let end = length - 22
  for (; end >= 0 && view.getUint32(end, true) !== 0x06054b50; end -= 1)
    if (end === 0 || length - end > 65_558) return "unreadable"
  if (end < 0) return "unreadable"
  // A Zip64 end record's locator, just before the end record.
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) return "too-large"
  const entries = view.getUint16(end + 8, true)
  let at = view.getUint32(end + 16, true)
  let all = 0
  for (let entry = 0; entry < entries; entry += 1) {
    if (at + 46 > length || view.getUint32(at, true) !== 0x02014b50) return "unreadable"
    const method = view.getUint16(at + 10, true)
    const size = view.getUint32(at + 24, true)
    // A size in a Zip64 field: past what's taken anyway.
    if (size === 0xffffffff || view.getUint32(at + 20, true) === 0xffffffff) return "too-large"
    // What's stored is a slice of the file; what's deflated, a buffer of the size it claims.
    if (method === 8) all += size
    if (all > claimLimits.all) return "too-large"
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true)
  }
  return null
}

/** Millimetres in one of a 3MF's units, as its model names it; 1 where it names none. */
export const millimetresPer: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
}

/** The most pixels one image a model draws may have, and all of them. */
export const pixelLimits = { one: 8192 * 8192, all: 128 * 1024 * 1024 } as const

/**
 * The size an image's own header claims, as a decoder allocates it: a PNG's, a JPEG's or a
 * WebP's; undefined for another format, or one whose header can't be read.
 */
export const imageSize = (bytes: Uint8Array): { width: number; height: number } | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = bytes.byteLength
  const text = (at: number, size: number) => String.fromCharCode(...bytes.subarray(at, at + size))
  if (length >= 24 && view.getUint32(0) === 0x89504e47)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  if (length >= 4 && view.getUint16(0) === 0xffd8) {
    let at = 2
    while (at + 9 <= length && bytes[at] === 0xff) {
      const marker = bytes[at + 1]!
      // A frame's start, which gives its size: any but the Huffman, arithmetic and JPEG-LS ones.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
      at += 2 + view.getUint16(at + 2)
    }
    return undefined
  }
  if (length >= 30 && text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    const chunk = text(12, 4)
    if (chunk === "VP8 ")
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === "VP8L") {
      const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!]
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      }
    }
    if (chunk === "VP8X")
      return {
        width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
        height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
      }
  }
  return undefined
}

/** Why a model's images can't be drawn as their headers claim, or null where they can. */
export const imagesTrouble = (images: Iterable<Uint8Array>): ClaimTrouble | null => {
  let all = 0
  for (const image of images) {
    const size = imageSize(image)
    if (!size) continue
    const pixels = size.width * size.height
    if (pixels > pixelLimits.one) return "too-large"
    all += pixels
    if (all > pixelLimits.all) return "too-large"
  }
  return null
}

// How much of an image a header is looked for in: a JPEG's frame may follow its metadata.
const headBytes = 256 * 1024

// The bytes of a `data:` address, as far as `limit`.
const dataBytes = (uri: string, limit: number): Uint8Array | undefined => {
  const comma = uri.indexOf(",")
  if (comma < 0 || !/;base64$/i.test(uri.slice(0, comma))) return undefined
  const text = uri.slice(comma + 1, comma + 1 + Math.ceil(limit / 3) * 4)
  try {
    return Uint8Array.from(atob(text.slice(0, text.length - (text.length % 4))), (char) =>
      char.charCodeAt(0),
    )
  } catch {
    return undefined
  }
}

/**
 * The start of each image a glTF draws, wherever it is: a file beside it (`named`, by its
 * address as written), a `data:` address, or a buffer view, of a GLB's own buffer (`bin`) or of
 * one the glTF names. One that can't be found is left to the loader, which fails it.
 */
export const gltfImages = (
  json: Json,
  bin: Uint8Array | undefined,
  named: ReadonlyMap<string, Uint8Array>,
): Uint8Array[] => {
  const buffers = list(json.buffers)
  const views = list(json.bufferViews)
  const whole = new Map<number, Uint8Array | undefined>()
  const bufferOf = (index: number): Uint8Array | undefined => {
    if (!whole.has(index)) {
      const uri = buffers[index]?.uri
      whole.set(
        index,
        typeof uri !== "string"
          ? bin
          : uri.startsWith("data:")
            ? dataBytes(uri, Number.MAX_SAFE_INTEGER)
            : named.get(uri),
      )
    }
    return whole.get(index)
  }
  return list(json.images).flatMap((image) => {
    if (typeof image.uri === "string") {
      const found = image.uri.startsWith("data:")
        ? dataBytes(image.uri, headBytes)
        : named.get(image.uri)
      return found ? [found.subarray(0, headBytes)] : []
    }
    const view = views[image.bufferView as number]
    const buffer = view && bufferOf(view.buffer as number)
    if (!view || !buffer) return []
    const start = count(view.byteOffset ?? 0)
    if (Number.isNaN(start) || start >= buffer.length) return []
    return [buffer.subarray(start, Math.min(buffer.length, start + headBytes))]
  })
}

/** A GLB's own buffer, its second chunk, or undefined where it has none. */
export const glbBin = (bytes: ArrayBuffer): Uint8Array | undefined => {
  if (bytes.byteLength < 20) return undefined
  const view = new DataView(bytes)
  const next = 20 + view.getUint32(12, true)
  if (next + 8 > bytes.byteLength || view.getUint32(next + 4, true) !== 0x004e4942) return undefined
  const length = Math.min(view.getUint32(next, true), bytes.byteLength - next - 8)
  return new Uint8Array(bytes, next + 8, length)
}
