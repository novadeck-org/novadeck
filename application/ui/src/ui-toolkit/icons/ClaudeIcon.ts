import { createLucideIcon } from "lucide-react"

// Clawd: a wide stepped body with side claws, two tall eyes, and two pairs of legs.
export const ClaudeIcon = createLucideIcon("Claude", [
  ["path", { d: "M4 6h16v4h2v4h-2v2H4v-2H2v-4h2Z", key: "body" }],
  ["path", { d: "M6 16v3m3-3v3m6-3v3m3-3v3", key: "legs" }],
  ["path", { d: "M8 9.5V11m8-1.5V11", key: "eyes" }],
])
