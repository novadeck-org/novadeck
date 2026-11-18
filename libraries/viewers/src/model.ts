import type { FrameCode } from "./frame/host.js"
import type { PaneAction } from "./frame/messages.js"
import { mountFrame } from "./frame/mount.js"
import type { Mount, Viewer, ViewerState } from "./index.js"
import {
  isView,
  modelMessage,
  type ModelFormat,
  type ModelFrameMessage,
  type ModelTrouble,
  type ModelView,
} from "./model/messages.js"

export type { ModelFormat, ModelTrouble, ModelView } from "./model/messages.js"

// A 3D model, drawn by three.js in a frame of its own (model/frame-viewer.ts), never in the
// app's page, as a PDF is (frame/mount.ts): the model's bytes and the files beside it it names
// go in, transferred; out come only the small messages model/messages.ts checks: where the
// camera is and what's toggled, why it isn't drawn, whether it's busy, a still of it, and the
// pane's actions for its keys. A script a model somehow ran in the frame reaches neither the
// app's page, its storage, nor its connection to the runner.
//
// The camera turns, moves and zooms around the model, fitted to it at first; a bar toggles the
// grid, wireframe and flat shading, and plays a glTF's animation; a chip gives its size. Its
// state, kept as the other viewers' is, is the camera and those toggles, so a model written
// again is drawn where it was looked at.

/** A model's bytes, its format, and the files beside it it names as the runner read them. */
export type ModelContent = {
  readonly format: ModelFormat
  readonly bytes: Blob
  readonly files: readonly { readonly name: string; readonly bytes: Blob }[]
  readonly refused: readonly { readonly name: string; readonly reason: string }[]
}

export type ModelViewer = Viewer<ModelContent>

/**
 * The frame, as the app serves it: its page's address (frame/frame.html, as `viewer-frame.html`
 * beside the app's own), and the viewer's code, three.js with it, as one script
 * (model/frame-entry.ts bundled). `viewer` is one more script setting the frame's entry, as a
 * test of the frame's walls gives.
 */
export type ModelFrame = {
  readonly url: string
  readonly code: FrameCode
  readonly viewer?: string
}

type ModelState = { readonly model: ModelView }
const isModelState = (state: unknown): state is ModelState =>
  isView((state as Partial<ModelState> | null)?.model)

// The tokens the frame draws with, read from where the viewer mounts (see model.css).
const tokens = [
  "--model-ground",
  "--model-surface",
  "--model-grid",
  "--model-notice-fg",
  "--model-chip-bg",
  "--model-chip-fg",
  "--model-chip-border",
  "--model-chip-radius",
  "--model-chip-shadow",
  "--model-chip-font",
  "--model-chip-hover-bg",
  "--model-chip-on-bg",
]

// The model and its files, as the frame takes them: each a buffer of its own, transferred.
const opening = async (
  content: ModelContent,
): Promise<{ message: Record<string, unknown>; transfer: ArrayBuffer[] }> => {
  const bytes = await content.bytes.arrayBuffer()
  const files = await Promise.all(
    content.files.map(async ({ name, bytes: file }) => ({ name, bytes: await file.arrayBuffer() })),
  )
  return {
    message: { type: "open", format: content.format, bytes, files, refused: content.refused },
    transfer: [bytes, ...files.map((file) => file.bytes)],
  }
}

/**
 * Mounts a 3D model viewer in its frame. `onTrouble` hears why a model it was given isn't
 * drawn; `onAction` hears what the pane does for a key pressed in it, only while the frame has
 * the focus.
 */
export const mountModel: Mount<
  ModelContent,
  {
    readonly frame: ModelFrame
    readonly onTrouble?: (trouble: ModelTrouble | null) => void
    readonly onAction?: (action: PaneAction) => void
  },
  ModelViewer
> = (element, { content, label, saved, frame, onTrouble, onAction }) => {
  let view: ModelView | undefined = isModelState(saved) ? saved.model : undefined
  let trouble: ModelTrouble | null | undefined
  let latest = 0
  const mounted = mountFrame<Exclude<ModelFrameMessage, { type: "ready" | "busy" | "action" }>>(
    element,
    {
      name: "model",
      label,
      url: frame.url,
      code: frame.code,
      viewer: frame.viewer,
      tokens,
      stoppedText: "The 3D viewer stopped.",
      check: modelMessage,
      onStopped: () => onTrouble?.("unreadable"),
      onAction,
      drag: true,
      visibility: true,
      hear: (message) => {
        switch (message.type) {
          case "place":
            view = message.view
            return
          case "trouble":
            if (message.trouble === trouble) return
            trouble = message.trouble
            return onTrouble?.(message.trouble)
          case "thumb":
            return
        }
      },
    },
  )

  // The newest model only: one read while an older one was still read goes in after it.
  const open = async (next: ModelContent): Promise<void> => {
    const at = (latest += 1)
    const { message, transfer } = await opening(next)
    if (at === latest) mounted.post(message, transfer)
  }

  if (view) mounted.post({ type: "place", view })
  void open(content)

  return {
    // A model written again is drawn where it was looked at.
    update: (next) => void open(next),
    state: () => (view ? ({ model: view } as unknown as ViewerState) : ({} as ViewerState)),
    restore: (state) => {
      if (!isModelState(state)) return
      view = state.model
      mounted.post({ type: "place", view: state.model })
    },
    jumpTo: () => {},
    focus: mounted.focus,
    destroy: mounted.destroy,
  }
}

/** The largest still the frame makes, square, in pixels. */
export const largestStill = 512

export type ModelStills = {
  /** A still of `content`, fitted, as a PNG `size` pixels square; null where none is drawn. */
  readonly still: (content: ModelContent, size: number) => Promise<Blob | null>
  readonly destroy: () => void
}

// How long a still may take, read and drawn, before it's given up on.
const stillMs = 20_000

/**
 * Stills of models, for a peek or a folder's grid, from one frame out of sight that draws them
 * one after another, so many stills hold one WebGL context at a time. The frame is the
 * viewer's own, walled in as it is.
 */
export const modelStills = (document: Document, frame: ModelFrame): ModelStills => {
  const box = document.createElement("div")
  box.setAttribute("aria-hidden", "true")
  box.style.cssText =
    "position: fixed; left: -10000px; top: 0; width: 64px; height: 64px; pointer-events: none"
  document.body.append(box)
  let id = 0
  const waiting = new Map<number, (bytes: ArrayBuffer | null) => void>()
  let troubled: (() => void) | undefined
  const mounted = mountFrame<Exclude<ModelFrameMessage, { type: "ready" | "busy" | "action" }>>(
    box,
    {
      name: "model",
      label: "Model still",
      url: frame.url,
      code: frame.code,
      viewer: frame.viewer,
      tokens,
      stoppedText: "",
      check: modelMessage,
      many: ["open", "thumb", "visible"],
      onStopped: () => {
        for (const done of waiting.values()) done(null)
        waiting.clear()
      },
      hear: (message) => {
        if (message.type === "thumb") {
          waiting.get(message.id)?.(message.bytes)
          waiting.delete(message.id)
        }
        if (message.type === "trouble" && message.trouble !== null) troubled?.()
      },
    },
  )
  // Never drawn but as a still: the frame holds no context of its own.
  mounted.post({ type: "visible", visible: false })
  // One after another: a still waits for the one before it.
  let line: Promise<unknown> = Promise.resolve()
  const still = (content: ModelContent, size: number): Promise<Blob | null> => {
    const made = line.then(async () => {
      const at = (id += 1)
      const { message, transfer } = await opening(content)
      return new Promise<Blob | null>((done) => {
        const finish = (bytes: ArrayBuffer | null): void => {
          clearTimeout(late)
          troubled = undefined
          waiting.delete(at)
          done(bytes ? new Blob([bytes], { type: "image/png" }) : null)
        }
        const late = setTimeout(() => finish(null), stillMs)
        troubled = () => finish(null)
        waiting.set(at, finish)
        mounted.post(message, transfer)
        mounted.post({
          type: "thumb",
          id: at,
          size: Math.min(Math.max(16, Math.round(size)), largestStill),
        })
      })
    })
    line = made.catch(() => null)
    return made
  }
  return {
    still,
    destroy: () => {
      mounted.destroy()
      box.remove()
    },
  }
}
