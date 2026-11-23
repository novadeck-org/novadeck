import { ContextMenu } from "@novadeck/toolkit/ContextMenu"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { AppWindow } from "lucide-react"
import { createContext, useContext, type ReactElement } from "react"

// Project windows in the switcher and the pins bar (desktop app, Experimental): which projects
// another window shows, marked quietly, and the menu that opens a project in a window of its own.

// What the lists know of the windows: absent while project windows are off.
export type ProjectWindowsView = {
  // The ids of the projects other windows show.
  readonly elsewhere: ReadonlySet<string>
  // Opens a project in a new window, even when a window shows it already.
  readonly open: (projectId: string) => void
}

export const ProjectWindowsContext = createContext<ProjectWindowsView | null>(null)

export const useProjectWindows = (): ProjectWindowsView | null => useContext(ProjectWindowsContext)

export const otherWindowText = "Shown in another window"

// The mark of a project another window shows: a small window glyph, quiet like the pin's, that
// a tooltip and a screen reader name.
export const OtherWindowMark = (): React.JSX.Element => (
  <Tooltip content={otherWindowText}>
    <span role="img" aria-label={otherWindowText} className="other-window-mark flex shrink-0">
      <AppWindow aria-hidden="true" size={12} strokeWidth={1.8} />
    </span>
  </Tooltip>
)

// A project's menu: "Open in new window", on a right-click of `children`, which holds a row or
// a pin, for any project, this window's own too; not while project windows are off. `contents` wraps `children` in an element that adds no box of its own, for
// a child that is not one element.
export const ProjectWindowMenu = ({
  project,
  contents = false,
  children,
}: {
  readonly project: { readonly id: string; readonly name: string }
  readonly contents?: boolean
  readonly children: ReactElement
}): ReactElement => {
  const windows = useProjectWindows()
  if (!windows) return children
  return (
    <ContextMenu
      label={`${project.name} actions`}
      trigger={contents ? <span className="contents">{children}</span> : children}
      items={[
        {
          value: "open-in-new-window",
          label: "Open in new window",
          icon: <AppWindow size={14} strokeWidth={1.75} aria-hidden />,
          onSelect: () => windows.open(project.id),
        },
      ]}
    />
  )
}
