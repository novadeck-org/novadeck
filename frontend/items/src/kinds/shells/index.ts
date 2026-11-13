import { SquareTerminal } from "lucide-react"

import type { ItemRegistration } from "../../registration"
import { ShellsThumb } from "./ShellsThumb"
import { ShellsView } from "./ShellsView"

// The background shells a terminal's agent left running, one item per terminal: a live tail
// of each, in the pane. It is the runner's, not the agent's to show.
export const shells = {
  kind: "shells",
  names: { one: "shells", many: "Shells" },
  icon: () => SquareTerminal,
  stackIcon: SquareTerminal,
  look: (item) => ({ name: item.name, label: item.name }),
  Thumb: ShellsThumb,
  View: ShellsView,
} satisfies ItemRegistration<"shells">
