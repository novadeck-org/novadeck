import { createLucideIcon } from "lucide-react"

// The pi mark: a 4×4 pixel glyph, a bar hooking down over a stepped left leg, with a short right
// leg meeting the hook's corner. Traced from pi's own mark (pi-mono's PiLogo, MIT; pi.dev's favicon
// is the same glyph) as outlines on 4-unit cells, the way the Claude icon traces Clawd's pixels.
export const PiIcon = createLucideIcon("Pi", [
  ["path", { d: "M4 4h12v8h-4v4H8v4H4Z", key: "glyph" }],
  ["path", { d: "M8 8h4v4H8Z", key: "hole" }],
  ["path", { d: "M16 12h4v8h-4Z", key: "leg" }],
])
