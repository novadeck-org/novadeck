import {
  LayoutGrid,
  Scan,
  PanelLeft,
  Search,
  Settings2,
  SquareDashedMousePointer,
} from "lucide-react"
import { useSyncExternalStore } from "react"
import { Link } from "react-router"

import { shortcutBindings } from "../interaction/shortcuts"
import type { Project, ViewMode } from "../model/types"
import { WorkspaceSwitcher } from "../projects/WorkspaceSwitcher"
import { DeckMark, DeckWordmark } from "../ui-toolkit/DeckLogo"
import { SegmentGroup } from "../ui-toolkit/SegmentGroup"
import { Tooltip } from "../ui-toolkit/Tooltip"

const iconOnlyQuery = "(max-width: 701px)"
const subscribe = (notify: () => void): (() => void) => {
  const media = window.matchMedia(iconOnlyQuery)
  media.addEventListener("change", notify)
  return () => media.removeEventListener("change", notify)
}
const isIconOnly = (): boolean => window.matchMedia(iconOnlyQuery).matches

const views = [
  { id: "focus", label: "Focus", icon: PanelLeft },
  { id: "grid", label: "Grid", icon: LayoutGrid },
  { id: "canvas", label: "Canvas", icon: SquareDashedMousePointer },
] as const

export const WorkspaceHeader = ({
  hidden = false,
  view,
  enabledViews,
  projects,
  project,
  onProjectSelect,
  onOpenFolder,
  onProjectRemove,
  onViewChange,
  homeTo,
  onSearch,
  onPreferences,
  onZen,
}: {
  hidden?: boolean
  view: ViewMode
  enabledViews: ViewMode[]
  projects: Project[]
  project: Project
  onProjectSelect: (id: string) => void
  // Absent where no folder can be opened; the switcher then shows it disabled.
  onOpenFolder?: (() => void) | undefined
  onProjectRemove?: ((id: string) => void) | undefined
  onViewChange: (mode: ViewMode) => void
  homeTo: string
  onSearch: () => void
  onPreferences: () => void
  onZen: () => void
}): React.JSX.Element => {
  const iconOnly = useSyncExternalStore(subscribe, isIconOnly)
  const searchShortcut = shortcutBindings().find.display.join(" ")
  // With one view left there's nothing to switch to: the switch goes, and Zen joins the
  // actions on the right.
  const switchable = enabledViews.length > 1
  const zen = (
    <Tooltip content={`Zen · ${shortcutBindings().zen.display.join(" ")}`}>
      <button
        data-workspace-zen-enter
        className="icon-button zen-enter"
        aria-label="Enter Zen mode"
        onClick={onZen}
      >
        <Scan size={16} />
      </button>
    </Tooltip>
  )
  return (
    <header
      hidden={hidden}
      inert={hidden}
      aria-hidden={hidden}
      className="app-header max-[1001px]:gap-3 max-[701px]:h-15 max-[701px]:px-3 max-[701px]:gap-2 max-[335px]:px-1 h-16 shrink-0 items-center gap-6 px-4 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
    >
      <div className="header-workspace max-[701px]:gap-2 flex min-w-0 items-center gap-4">
        <Link
          to={homeTo}
          className="brand max-[701px]:w-auto max-[701px]:text-[17px] max-[701px]:gap-[7px] min-[702px]:max-[1001px]:[&>span:last-child]:hidden flex shrink-0 items-center gap-2 text-[16px] font-semibold"
          aria-label="novadeck. home"
        >
          <DeckMark size={28} className="brand-symbol" />
          <DeckWordmark />
        </Link>
        <WorkspaceSwitcher
          projects={projects}
          current={project}
          onSelect={onProjectSelect}
          onOpenFolder={onOpenFolder}
          onRemove={onProjectRemove}
        />
      </div>
      <div
        data-workspace-view-switch
        className="header-view-controls relative flex shrink-0 items-center"
      >
        {switchable && (
          <>
            <SegmentGroup
              label="Workspace layout"
              tooltips={iconOnly}
              className="view-switch max-[701px]:gap-0 flex shrink-0 gap-1"
              itemClassName="flex h-8 min-w-22 items-center justify-center gap-2 px-3 text-control max-[701px]:min-w-0 max-[701px]:w-8 max-[701px]:px-2 max-[701px]:gap-0 max-[701px]:text-caption [&>span]:max-[701px]:hidden"
              items={views
                .filter(({ id }) => enabledViews.includes(id))
                .map(({ id, label, icon: Icon }) => ({
                  value: id,
                  label,
                  icon: <Icon size={14} strokeWidth={1.6} aria-hidden="true" />,
                }))}
              indicatorClassName="view-switch-indicator"
              value={view}
              onValueChange={(value) => {
                const mode = enabledViews.find((candidate) => candidate === value)
                if (mode) onViewChange(mode)
              }}
            />
            <div className="absolute left-[calc(100%+0.5rem)] flex items-center gap-2 max-[701px]:left-[calc(100%+0.25rem)] max-[701px]:gap-1">
              <div className="separator h-4 w-px" aria-hidden="true" />
              {zen}
            </div>
          </>
        )}
      </div>
      <div className="header-actions max-[1001px]:ml-0 max-[701px]:shrink-0 max-[701px]:gap-0 flex items-center justify-self-end gap-2">
        {!switchable && zen}
        <Tooltip content={`Search · ${searchShortcut}`} disabled={!iconOnly}>
          <button
            className="icon-button header-search w-auto gap-2 px-2.5 text-control max-[701px]:w-8 max-[701px]:gap-0 max-[701px]:px-0"
            aria-label="Find a terminal"
            onClick={onSearch}
          >
            <Search size={15} />
            <span className="max-[701px]:hidden">Search</span>
            <kbd className="hint mb-[-2px] ml-3 max-[701px]:hidden">{searchShortcut}</kbd>
          </button>
        </Tooltip>
        <Tooltip content={`Preferences · ${shortcutBindings().preferences.display.join(" ")}`}>
          <button
            className="icon-button"
            onClick={onPreferences}
            aria-label="Workspace preferences"
          >
            <Settings2 size={16} />
          </button>
        </Tooltip>
      </div>
    </header>
  )
}
