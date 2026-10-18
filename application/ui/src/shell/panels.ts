import type { SidebarPanel } from "#core/types"

// What each sidebar panel is called to assistive technology, on the sidebar and its phone drawer.
export const panelLabels: Readonly<Record<SidebarPanel, string>> = {
  terminals: "Terminal sessions",
  sessions: "Workspace sessions",
  notifications: "Notifications",
  inbox: "Inbox",
}

// The panel the sidebar shows for the one its link names: a link to Notifications opens the
// Inbox where the backend has one, and a link to the Inbox opens Notifications where it has
// none.
export const shownPanel = (panel: SidebarPanel, inbox: boolean): SidebarPanel => {
  if (inbox) return panel === "notifications" ? "inbox" : panel
  return panel === "inbox" ? "notifications" : panel
}
