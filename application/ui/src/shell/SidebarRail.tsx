import { History, Terminal as TerminalIcon } from "lucide-react"

import { workspaceShortcutBindings } from "../interaction/shortcuts"
import { ToggleGroup, ToggleGroupItem } from "../ui-toolkit/ToggleGroup"

export const SidebarRail = ({
  mobile = false,
  sidebarVisible,
  sidebarPanel,
  zen,
  toggleSidebar,
  hideSidebar,
}: {
  mobile?: boolean
  sidebarVisible: boolean
  sidebarPanel: "terminals" | "sessions"
  zen: boolean
  toggleSidebar: (panel: "terminals" | "sessions") => void
  hideSidebar: () => void
}): React.JSX.Element => (
  <ToggleGroup
    className="sidebar-tools z-30 w-11 shrink-0 flex-col items-center gap-1 px-1.5 py-3"
    aria-label="Sidebar actions"
    aria-hidden={Boolean(zen)}
    orientation="vertical"
    value={sidebarVisible ? [sidebarPanel] : []}
    onValueChange={(value) => {
      const next = value[0]
      if (next === "terminals" || next === "sessions") toggleSidebar(next)
      else hideSidebar()
    }}
  >
    {(
      [
        { id: "terminals", label: "Terminals", icon: TerminalIcon },
        { id: "sessions", label: "Sessions", icon: History },
      ] as const
    ).map(({ id, label, icon: Icon }) => {
      const activePanel = sidebarPanel === id && sidebarVisible
      return (
        <ToggleGroupItem
          key={id}
          tooltip={
            id === "terminals"
              ? `Terminals · ${workspaceShortcutBindings().terminals.display.join(" ")}`
              : label
          }
          value={id}
          id={`${mobile ? "mobile-" : ""}${id}-toggle`}
          className="segment inline-flex size-8 shrink-0 items-center justify-center p-2 [&>svg]:shrink-0"
          aria-label={label}
          aria-controls={`${id}-panel`}
          aria-expanded={activePanel}
        >
          <Icon size={17} />
        </ToggleGroupItem>
      )
    })}
  </ToggleGroup>
)
