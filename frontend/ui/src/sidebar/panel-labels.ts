import type { SidebarPanel } from "@novadeck/core/types"

// What each sidebar panel is called: its heading, its rail toggle and its tooltip, and its name
// to assistive technology, on the sidebar and its phone drawer.
export const panelLabels: Readonly<Record<SidebarPanel, string>> = {
  terminals: "Terminals",
  inbox: "Inbox",
  sessions: "Sessions",
  worktrees: "Worktrees",
  files: "Files",
  history: "History",
}
