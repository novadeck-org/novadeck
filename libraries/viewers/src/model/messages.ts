import {
  between,
  commonMessage,
  only,
  record,
  whole,
  type CommonMessage,
} from "../frame/messages.js"

// What the 3D model viewer's frame may tell the app, checked field by field: anything else, a
// field more or a value out of its range, is dropped. The frame runs three.js on files anyone
// may have written, so the app trusts none of it beyond these shapes.

/** The formats the frame draws, as the runner names them. */
export type ModelFormat = "glb" | "gltf" | "stl" | "obj" | "ply" | "3mf"

/**
 * Why a model isn't drawn: no loader could read it, it's compressed in a way the frame carries
 * no decoder for, it claims more than the frame draws, it has nothing to draw, or there's no
 * WebGL to draw with.
 */
export type ModelTrouble = "unreadable" | "unsupported" | "too-large" | "empty" | "webgl"

type Triple = readonly [number, number, number]

/** Where the camera is and what it looks at, and what's toggled: a model's kept state. */
export type ModelView = {
  readonly target: Triple
  readonly position: Triple
  readonly grid: boolean
  readonly wireframe: boolean
  readonly flat: boolean
  readonly playing: boolean
}

export type ModelFrameMessage =
  | CommonMessage
  | { readonly type: "place"; readonly view: ModelView }
  | { readonly type: "trouble"; readonly trouble: ModelTrouble | null }
  | { readonly type: "thumb"; readonly id: number; readonly bytes: ArrayBuffer | null }

// The furthest a point of a view is taken to be, in the model's units; the largest still.
const reach = 1e12
export const thumbBytes = 1024 * 1024
const troubles = new Set<unknown>(["unreadable", "unsupported", "too-large", "empty", "webgl"])

const isTriple = (value: unknown): value is Triple =>
  Array.isArray(value) && value.length === 3 && value.every((each) => between(each, -reach, reach))

/** A view, if `value` is one exactly. */
export const isView = (value: unknown): value is ModelView => {
  const view = record(value)
  if (!view || !only(view, ["target", "position", "grid", "wireframe", "flat", "playing"]))
    return false
  if (!isTriple(view.target) || !isTriple(view.position)) return false
  // A camera at what it looks at sees nothing.
  if (view.target.every((each, axis) => each === (view.position as Triple)[axis])) return false
  return ["grid", "wireframe", "flat", "playing"].every((key) => typeof view[key] === "boolean")
}

// A PNG's first eight bytes.
const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const isPng = (bytes: ArrayBuffer): boolean =>
  bytes.byteLength > png.length &&
  bytes.byteLength <= thumbBytes &&
  png.every((byte, at) => new Uint8Array(bytes, 0, png.length)[at] === byte)

/** A message from the frame, if it is one of these shapes exactly; undefined otherwise. */
export const modelMessage = (data: unknown): ModelFrameMessage | undefined => {
  const message = record(data)
  if (!message) return undefined
  switch (message.type) {
    case "place":
      return only(message, ["type", "view"]) && isView(message.view)
        ? { type: "place", view: message.view }
        : undefined
    case "trouble": {
      const { trouble } = message
      if (!only(message, ["type", "trouble"])) return undefined
      return trouble === null || troubles.has(trouble)
        ? { type: "trouble", trouble: trouble as ModelTrouble | null }
        : undefined
    }
    case "thumb": {
      const { id, bytes } = message
      if (!only(message, ["type", "id", "bytes"]) || !whole(id, 1, Number.MAX_SAFE_INTEGER))
        return undefined
      if (bytes === null) return { type: "thumb", id, bytes: null }
      return bytes instanceof ArrayBuffer && isPng(bytes) ? { type: "thumb", id, bytes } : undefined
    }
    default:
      return commonMessage(message)
  }
}
