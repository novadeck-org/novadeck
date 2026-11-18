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
 * Why a 3MF can't be read as it claims: the sizes its zip's central directory gives its
 * entries, which the unzipping allocates, past `claimLimits.all` in all; or null where it can.
 */
export const zipTrouble = (bytes: ArrayBuffer): ClaimTrouble | null => {
  const view = new DataView(bytes)
  // The end of central directory record, in the last 64 KiB and 22 bytes.
  let end = -1
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 65_557); at -= 1)
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  if (end < 0) return "unreadable"
  const entries = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  let all = 0
  for (let entry = 0; entry < entries; entry += 1) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) return "unreadable"
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    // A Zip64 entry's size is in its extra field: past what's taken anyway.
    if (size === 0xffffffff) return "too-large"
    all += size
    if (all > claimLimits.all) return "too-large"
    at += 46 + nameLength + extraLength + commentLength
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
