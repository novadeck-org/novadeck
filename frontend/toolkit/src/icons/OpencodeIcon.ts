import { createLucideIcon } from "lucide-react"

// The opencode mark: a tall frame whose opening holds a block in its lower half. Traced from
// opencode's own mark (packages/identity/mark.svg, MIT), as strokes on the 24-unit grid.
export const OpencodeIcon = createLucideIcon("Opencode", [
  ["rect", { x: "7", y: "5", width: "10", height: "14", key: "frame" }],
  ["rect", { x: "10", y: "11.5", width: "4", height: "4", key: "block" }],
])
