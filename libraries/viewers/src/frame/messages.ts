// What a viewer's frame may tell the app, by the shapes every viewer's checks share: its
// own messages check the rest. The frame runs code on bytes anyone may have written, so the app
// trusts none of it beyond these shapes.

/** What the pane does for a key pressed in a frame, which stays with the pane. */
export type PaneAction = "hide" | "next-tab" | "previous-tab"

/** The messages every viewer's frame sends: started, working, and a key's pane action. */
export type CommonMessage =
  | { readonly type: "ready" }
  | { readonly type: "busy"; readonly busy: boolean }
  | { readonly type: "action"; readonly action: PaneAction }

export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
export const only = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))
export const whole = (value: unknown, low: number, high: number): value is number =>
  Number.isInteger(value) && (value as number) >= low && (value as number) <= high
export const between = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high

/** One of the messages every frame sends, if `message` is one exactly; undefined otherwise. */
export const commonMessage = (message: Record<string, unknown>): CommonMessage | undefined => {
  switch (message.type) {
    case "ready":
      return only(message, ["type"]) ? { type: "ready" } : undefined
    case "busy":
      return only(message, ["type", "busy"]) && typeof message.busy === "boolean"
        ? { type: "busy", busy: message.busy }
        : undefined
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
