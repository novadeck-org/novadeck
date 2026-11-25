import { createLucideIcon } from "lucide-react"

// The opencode mark: a 4:5 frame whose opening holds a square block in its lower two thirds,
// filling the opening's width. Traced from opencode's own mark (packages/identity/mark.svg, MIT)
// as outlines on the 24-unit grid, a little inside Lucide's portrait keyline, as a full-height
// frame reads larger than the round Codex cloud beside it.
export const OpencodeIcon = createLucideIcon("Opencode", [
  ["path", { d: "M5 3h14v18H5Z", key: "frame" }],
  ["path", { d: "M8.5 10.5h7v7h-7Z", key: "block" }],
])
