import { createLucideIcon } from "lucide-react"

// The opencode mark: a 4:5 frame whose opening holds a block in its lower half, filling the
// opening's width. Traced from opencode's own mark (packages/identity/mark.svg, MIT) as outlines
// on the 24-unit grid, filling the same 20-unit height as the other harness icons.
export const OpencodeIcon = createLucideIcon("Opencode", [
  ["path", { d: "M4 2h16v20H4Z", key: "frame" }],
  ["path", { d: "M8 12h8v6H8Z", key: "block" }],
])
