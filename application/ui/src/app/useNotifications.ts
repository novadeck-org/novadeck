import { notifications, type Notification } from "../notifications/notifications"
import { notificationBadge, type BellBadge } from "../shell/notification-badge"
import { useUiState, useWorkspaceState } from "./controller/context"
import { shallowEqual } from "./selectors"

const sameNotifications = (a: readonly Notification[], b: readonly Notification[]): boolean =>
  a.length === b.length && a.every((notification, index) => shallowEqual(notification, b[index]))

// What asks for the person across the workspace, as the notification center lists it,
// the most pressing first; a new list only when what it shows changed.
export const useNotifications = (): readonly Notification[] => {
  const unread = useUiState((state) => state.unread)
  // The selector closes over `unread`, so a new one is a new selector and recomputes.
  return useWorkspaceState(
    (workspace) => notifications(workspace.projects, unread),
    sameNotifications,
  )
}

// The bell's badge alone, for the small components that draw it: they re-render as the
// unread marks change, and otherwise only when the badge's count or tone does.
export const useNotificationBadge = (): BellBadge | undefined => {
  const unread = useUiState((state) => state.unread)
  return useWorkspaceState(
    (workspace) => notificationBadge(notifications(workspace.projects, unread)),
    shallowEqual,
  )
}
