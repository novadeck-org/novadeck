import { sidebarPanels, type SidebarPanel } from "@novadeck/core/types"
import { ToggleGroup, ToggleGroupItem } from "@novadeck/toolkit/ToggleGroup"
import { Bell, History, Inbox, Terminal as TerminalIcon } from "lucide-react"

import { shortcutBindings } from "../interaction/shortcuts"
import type { BellBadge } from "./notification-badge"
import { NotificationBadge } from "./NotificationBadge"

export const SidebarRail = ({
  mobile = false,
  sidebarVisible,
  sidebarPanel,
  zen,
  badge,
  inbox = false,
  toggleSidebar,
  hideSidebar,
}: {
  mobile?: boolean
  sidebarVisible: boolean
  sidebarPanel: SidebarPanel
  zen: boolean
  badge: BellBadge | undefined
  // Whether the backend has an Inbox, which takes the Notifications toggle's place.
  inbox?: boolean
  toggleSidebar: (panel: SidebarPanel) => void
  hideSidebar: () => void
}): React.JSX.Element => {
  return (
    <ToggleGroup
      className="sidebar-tools z-30 w-11 shrink-0 flex-col items-center gap-1 px-1.5 py-3"
      aria-label="Sidebar actions"
      aria-hidden={Boolean(zen)}
      orientation="vertical"
      value={sidebarVisible ? [sidebarPanel] : []}
      onValueChange={(value) => {
        const next = sidebarPanels.find((panel) => panel === value[0])
        if (next) toggleSidebar(next)
        else hideSidebar()
      }}
    >
      {(
        [
          { id: "terminals", label: "Terminals", icon: TerminalIcon },
          { id: "sessions", label: "Sessions", icon: History },
          inbox
            ? { id: "inbox", label: "Inbox", icon: Inbox }
            : { id: "notifications", label: "Notifications", icon: Bell },
        ] as const
      ).map(({ id, label, icon: Icon }) => {
        const status = id === "notifications" || id === "inbox" ? badge : undefined
        return (
          <ToggleGroupItem
            key={id}
            tooltip={
              id === "terminals"
                ? `Terminals · ${shortcutBindings().terminals.display.join(" ")}`
                : label
            }
            value={id}
            id={`${mobile ? "mobile-" : ""}${id}-toggle`}
            className="segment relative inline-flex size-8 shrink-0 items-center justify-center p-2 [&>svg]:shrink-0"
            aria-label={status?.label ?? label}
            data-project-status={status?.status}
          >
            <Icon size={16} />
            {status && <NotificationBadge text={status.text} />}
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}
