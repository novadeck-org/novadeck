import { Bell, History, Terminal as TerminalIcon } from "lucide-react"

import { shortcutBindings } from "../interaction/shortcuts"
import { sidebarPanels, type SidebarPanel } from "../model/types"
import { ToggleGroup, ToggleGroupItem } from "../ui-toolkit/ToggleGroup"
import type { BellBadge } from "./notification-badge"
import { NotificationBadge } from "./NotificationBadge"

export const SidebarRail = ({
  mobile = false,
  sidebarVisible,
  sidebarPanel,
  zen,
  badge,
  toggleSidebar,
  hideSidebar,
}: {
  mobile?: boolean
  sidebarVisible: boolean
  sidebarPanel: SidebarPanel
  zen: boolean
  badge: BellBadge | undefined
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
          { id: "notifications", label: "Notifications", icon: Bell },
        ] as const
      ).map(({ id, label, icon: Icon }) => {
        const activePanel = sidebarPanel === id && sidebarVisible
        const status = id === "notifications" ? badge : undefined
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
            aria-controls={`${id}-panel`}
            aria-expanded={activePanel}
          >
            <Icon size={17} />
            {status && <NotificationBadge text={status.text} />}
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}
