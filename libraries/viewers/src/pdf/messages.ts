// What the PDF viewer's frame may tell the app, checked field by field: anything else, a field
// more or a value out of its range, is dropped. The frame runs pdf.js on bytes anyone may have
// written, so the app trusts none of it beyond these shapes.

/** Fitted to the viewer's width, or a scale of the PDF's actual size (1 is 100%). */
export type PdfZoom = "fit" | number

/** Why a PDF isn't drawn: it asks for a password, or isn't a PDF pdf.js can read. */
export type PdfTrouble = "password" | "unreadable"

/** One of pdf.js's own files: a CMap, a standard font, or an image decoder. */
export type PdfAssetKind = "cmap" | "font" | "wasm"

/** What the pane does for a key pressed in the PDF, which stays with the pane. */
export type PdfPaneAction = "hide" | "next-tab" | "previous-tab"

export type PdfFrameMessage =
  | { readonly type: "ready" }
  | {
      readonly type: "place"
      readonly page: number
      readonly within: number
      readonly zoom: PdfZoom
      readonly scale: number
      readonly pages: number
    }
  | { readonly type: "trouble"; readonly trouble: PdfTrouble | null }
  | { readonly type: "busy"; readonly busy: boolean }
  | {
      readonly type: "asset"
      readonly id: number
      readonly kind: PdfAssetKind
      readonly name: string
    }
  | { readonly type: "action"; readonly action: PdfPaneAction }

// The most pages a PDF is taken to have, and the furthest it zooms.
const maxPages = 1_000_000
const maxZoom = 8
// A pdf.js file's name: its own files are named so, and nothing else is asked for.
const assetName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const only = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))
const whole = (value: unknown, low: number, high: number): value is number =>
  Number.isInteger(value) && (value as number) >= low && (value as number) <= high
const between = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high
const isZoom = (value: unknown): value is PdfZoom =>
  value === "fit" || between(value, 0.01, maxZoom)

/** A message from the frame, if it is one of these shapes exactly; undefined otherwise. */
export const frameMessage = (data: unknown): PdfFrameMessage | undefined => {
  const message = record(data)
  if (!message) return undefined
  switch (message.type) {
    case "ready":
      return only(message, ["type"]) ? { type: "ready" } : undefined
    case "place": {
      const { page, within, zoom, scale, pages } = message
      if (!only(message, ["type", "page", "within", "zoom", "scale", "pages"])) return undefined
      if (!whole(pages, 0, maxPages) || !whole(page, 0, Math.max(pages, 1) - 1)) return undefined
      if (!between(within, 0, 1) || !isZoom(zoom) || !between(scale, 0.01, maxZoom))
        return undefined
      return { type: "place", page, within, zoom, scale, pages }
    }
    case "trouble": {
      const { trouble } = message
      if (!only(message, ["type", "trouble"])) return undefined
      return trouble === null || trouble === "password" || trouble === "unreadable"
        ? { type: "trouble", trouble }
        : undefined
    }
    case "busy":
      return only(message, ["type", "busy"]) && typeof message.busy === "boolean"
        ? { type: "busy", busy: message.busy }
        : undefined
    case "asset": {
      const { id, kind, name } = message
      if (!only(message, ["type", "id", "kind", "name"]) || !whole(id, 1, Number.MAX_SAFE_INTEGER))
        return undefined
      if (kind !== "cmap" && kind !== "font" && kind !== "wasm") return undefined
      return typeof name === "string" && assetName.test(name)
        ? { type: "asset", id, kind, name }
        : undefined
    }
    case "action": {
      const { action } = message
      if (!only(message, ["type", "action"])) return undefined
      return action === "hide" || action === "next-tab" || action === "previous-tab"
        ? { type: "action", action }
        : undefined
    }
    default:
      return undefined
  }
}
