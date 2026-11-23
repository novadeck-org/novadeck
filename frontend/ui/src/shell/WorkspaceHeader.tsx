import { viewModes } from "@novadeck/core/state"
import type { Project, ViewMode } from "@novadeck/core/types"
import { NovaMark } from "@novadeck/toolkit/NovaLogo"
import { SegmentGroup } from "@novadeck/toolkit/SegmentGroup"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { views } from "@novadeck/toolkit/views"
import { Scan, Search, Settings2 } from "lucide-react"
import { useSyncExternalStore } from "react"
import { Link } from "react-router"

import { shortcutBindings } from "../interaction/shortcuts"
import type { ProjectArrangement } from "../projects/project-arrangement"
import type { ProjectStatus } from "../projects/project-status"
import { WorkspaceSwitcher } from "../projects/WorkspaceSwitcher"

// The side of the header the window's own controls sit at, where the desktop app puts them there
// (the root's `data-window-controls`, set by its entry before the first paint).
const controlsSide = (): string | undefined =>
  typeof document === "undefined" ? undefined : document.documentElement.dataset.windowControls

// The view switch gives up its words below 701px, as the `narrow-header` variant (styles.css)
// does.
const iconOnlyQuery = "(max-width: 701px)"
const subscribe = (notify: () => void): (() => void) => {
  const media = window.matchMedia(iconOnlyQuery)
  media.addEventListener("change", notify)
  return () => media.removeEventListener("change", notify)
}
const isIconOnly = (): boolean => window.matchMedia(iconOnlyQuery).matches

export const WorkspaceHeader = ({
  hidden = false,
  view,
  enabledViews,
  projects,
  project,
  statuses,
  asks,
  arrangement,
  onProjectMove,
  onProjectStep,
  onProjectTogglePin,
  onProjectSelect,
  onOpenFolder,
  onProjectRemove,
  dotIgnores,
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
  // What each project's terminals show, by its id, where they show anything, and what they
  // ask of the person, where they ask anything, for the switcher's dot.
  statuses: Readonly<Record<string, ProjectStatus>>
  asks: Readonly<Record<string, ProjectStatus>>
  // How the person arranged the projects, and the intents to change it.
  arrangement: ProjectArrangement
  onProjectMove: (id: string, index: number) => void
  onProjectStep: (id: string, by: -1 | 1) => void
  onProjectTogglePin: (id: string) => void
  onProjectSelect: (id: string) => void
  // Absent where no folder can be opened; the switcher then shows it disabled.
  onOpenFolder?: (() => void) | undefined
  onProjectRemove?: ((id: string) => void) | undefined
  // The pinned projects the bar shows, which the switcher's dot leaves out.
  dotIgnores: readonly string[]
  onViewChange: (mode: ViewMode) => void
  homeTo: string
  onSearch: () => void
  onPreferences: () => void
  onZen: () => void
}): React.JSX.Element => {
  const iconOnly = useSyncExternalStore(subscribe, isIconOnly)
  // Where the window's own controls sit in the header, its actions may give up their words for
  // the room, so Search always says itself in a tooltip. On macOS, whose apps leave their icon to
  // the Dock and the menu bar, the mark gives way to the window's buttons; the view switch's
  // first view is home there.
  const side = controlsSide()
  const controlled = side !== undefined
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
      className="app-header max-[1001px]:gap-3 max-[701px]:h-[var(--app-header-height,3.75rem)] max-[701px]:px-3 max-[701px]:gap-2 max-[335px]:px-1 h-[var(--app-header-height,4rem)] shrink-0 items-center gap-6 px-4 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
    >
      <div className="header-workspace max-[701px]:gap-2 flex min-w-0 items-center gap-4">
        {side !== "start" && (
          <Link to={homeTo} className="brand flex shrink-0 items-center" aria-label="Novadeck home">
            <NovaMark size={28} className="brand-symbol" />
          </Link>
        )}
        <WorkspaceSwitcher
          projects={projects}
          current={project}
          statuses={statuses}
          asks={asks}
          arrangement={arrangement}
          onSelect={onProjectSelect}
          onMove={onProjectMove}
          onStep={onProjectStep}
          onTogglePin={onProjectTogglePin}
          onOpenFolder={onOpenFolder}
          onRemove={onProjectRemove}
          dotIgnores={dotIgnores}
        />
      </div>
      <div
        data-workspace-view-switch
        data-tour="views"
        className="header-view-controls relative flex shrink-0 items-center"
      >
        {switchable && (
          <>
            <SegmentGroup
              label="Workspace layout"
              tooltips={iconOnly}
              className="view-switch narrow-header:gap-0 flex shrink-0 gap-1"
              itemClassName="flex h-8 min-w-22 items-center justify-center gap-2 px-3 text-control narrow-header:min-w-0 narrow-header:w-8 narrow-header:px-2 narrow-header:gap-0 narrow-header:text-caption [&>span]:narrow-header:hidden"
              items={viewModes
                .filter((id) => enabledViews.includes(id))
                .map((id) => {
                  const { label, icon: Icon } = views[id]
                  return {
                    value: id,
                    label,
                    icon: <Icon size={14} strokeWidth={1.6} aria-hidden="true" />,
                  }
                })}
              indicatorClassName="view-switch-indicator"
              value={view}
              onValueChange={(value) => {
                const mode = enabledViews.find((candidate) => candidate === value)
                if (mode) onViewChange(mode)
              }}
            />
            <div className="absolute left-[calc(100%+0.5rem)] flex items-center gap-2 narrow-header:left-[calc(100%+0.25rem)] narrow-header:gap-1">
              <div className="separator h-4 w-px" aria-hidden="true" />
              {zen}
            </div>
          </>
        )}
      </div>
      {/* The actions measure the room their column leaves them, less the Zen button's reach into
          it: the shortcut goes first, then Search's word. */}
      <div
        className={`header-actions @container/actions max-[1001px]:ml-0 max-[701px]:shrink-0 max-[701px]:gap-0 flex items-center justify-end justify-self-stretch gap-2 ${switchable ? "ps-9 max-[701px]:ps-0" : ""}`}
      >
        {!switchable && zen}
        <Tooltip content={`Search · ${searchShortcut}`} disabled={!iconOnly && !controlled}>
          <button
            className="icon-button header-search w-auto gap-2 px-2.5 text-control max-[701px]:w-8 max-[701px]:gap-0 max-[701px]:px-0 @max-[130px]/actions:w-8 @max-[130px]/actions:gap-0 @max-[130px]/actions:px-0"
            aria-label="Find a terminal"
            onClick={onSearch}
          >
            <Search size={14} />
            <span className="max-[701px]:hidden @max-[130px]/actions:hidden">Search</span>
            <kbd className="hint mb-[-2px] ml-3 max-[701px]:hidden @max-[214px]/actions:hidden">
              {searchShortcut}
            </kbd>
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
