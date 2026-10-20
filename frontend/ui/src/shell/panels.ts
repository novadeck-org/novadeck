import type { SidebarPanel } from "@novadeck/core/types"

// What each sidebar panel is called to assistive technology, on the sidebar and its phone drawer.
export const panelLabels: Readonly<Record<SidebarPanel, string>> = {
  terminals: "Terminal sessions",
  source: "Source",
  sessions: "Workspace sessions",
  inbox: "Inbox",
}
