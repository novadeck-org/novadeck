import { useLayoutEffect, useRef, useState } from "react"

import { Tooltip } from "../ui-toolkit/Tooltip"
import { chipsThatFit } from "./project-chip-fit"
import { needsPerson, statusText, type ProjectStatus } from "./project-status"

// The pinned projects, as quiet text chips after the switcher, in the person's order: each
// marks what its project's terminals ask of the person, and a click switches to it. The current one
// stays in its place, marked as current, so switching never moves the chips. They take the
// room the header leaves them: each shows whole or not at all, the last ones first to go,
// and `onShown` says which show. All stay in the group so each can be measured; the ones
// that don't fit are hidden and inert. With none showing, the rule goes too.
export const ProjectChips = ({
  projects,
  current,
  statuses,
  onSelect,
  onShown,
}: {
  projects: readonly { readonly id: string; readonly name: string; readonly directory: string }[]
  // The project the workspace shows.
  current: string
  // What each project's terminals show, by its id, where they show anything.
  statuses: Readonly<Record<string, ProjectStatus>>
  onSelect: (id: string) => void
  onShown: (ids: readonly string[]) => void
}): React.JSX.Element | null => {
  const group = useRef<HTMLDivElement>(null)
  const [count, setCount] = useState(projects.length)
  const shown = Math.min(count, projects.length)

  // Measures before paint, and again as the group or a chip changes size.
  useLayoutEffect(() => {
    const element = group.current
    if (!element || projects.length === 0) return
    const measure = (): void => {
      const style = getComputedStyle(element)
      const available =
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const widths = [...element.querySelectorAll<HTMLElement>(".project-chip")].map(
        (chip) => chip.offsetWidth,
      )
      setCount(chipsThatFit(available, widths, parseFloat(style.columnGap) || 0))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const chip of element.querySelectorAll(".project-chip")) observer.observe(chip)
    return () => observer.disconnect()
  }, [projects])

  // Tells which show, once at first and then only when they change.
  const told = useRef<readonly string[] | null>(null)
  useLayoutEffect(() => {
    const ids = projects.slice(0, shown).map(({ id }) => id)
    const before = told.current
    if (before && before.length === ids.length && before.every((id, i) => id === ids[i])) return
    told.current = ids
    onShown(ids)
  }, [projects, shown, onShown])

  if (projects.length === 0) return null
  return (
    <div
      ref={group}
      role="group"
      aria-label="Pinned projects"
      data-empty={shown === 0 ? "true" : undefined}
      className="project-chips flex min-w-0 flex-[1_1_0] items-center gap-1 overflow-hidden pl-2"
    >
      {projects.map((project, index) => {
        // A project only working shows nothing: the header stays still while agents work.
        const status = needsPerson(statuses[project.id]) ? statuses[project.id] : undefined
        const isCurrent = project.id === current
        return (
          <Tooltip key={project.id} content={project.directory}>
            <button
              type="button"
              inert={index >= shown}
              style={index >= shown ? { visibility: "hidden" } : undefined}
              className="project-chip flex h-7 min-w-0 max-w-35 shrink-0 items-center gap-1.5 px-2.5 text-control"
              aria-current={isCurrent ? "true" : undefined}
              aria-description={status && statusText[status]}
              data-project-status={status}
              onClick={() => {
                if (!isCurrent) onSelect(project.id)
              }}
            >
              {status && <span aria-hidden="true" className="project-status-mark" />}
              <span className="min-w-0 truncate">{project.name}</span>
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
