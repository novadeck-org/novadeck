import { createLucideIcon } from "lucide-react"

// The pi mark: a 4×4 pixel glyph, a bar hooking down over a stepped left leg, beside a short right
// leg. Traced from pi's own mark (pi.dev/favicon.svg, MIT) as outlines on the 24-unit grid, the way
// the Claude icon traces Clawd's pixels; the right leg stands a little apart so it stays clear at 16px.
export const PiIcon = createLucideIcon("Pi", [
  ["path", { d: "M3 3h13.5v8.5H12v5H7.5V21H3Z", key: "glyph" }],
  ["path", { d: "M7.5 7.5H12v4H7.5Z", key: "hole" }],
  ["path", { d: "M17 14h4v7h-4Z", key: "leg" }],
])
