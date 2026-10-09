import type { SidebarPanel } from "../model/types"

// What each sidebar panel is called to assistive technology, on the sidebar and its phone drawer.
export const panelLabels: Readonly<Record<SidebarPanel, string>> = {
  terminals: "Terminal sessions",
  sessions: "Workspace sessions",
  notifications: "Notifications",
}
