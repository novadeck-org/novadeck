import { createLucideIcon } from "lucide-react"

// A pi mark: the Greek letter, as a bar over two legs, the right one curling out, on the 24-unit
// grid. Drawn for Novadeck (pi's own mark is a wordless glyph too), not copied from its assets.
export const PiIcon = createLucideIcon("Pi", [
  ["path", { d: "M5 7h14", key: "bar" }],
  ["path", { d: "M9 7v11", key: "left" }],
  ["path", { d: "M15 7v8a3 3 0 0 0 3 3", key: "right" }],
])
