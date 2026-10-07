import { X } from "lucide-react"
import type { ReactNode } from "react"

import { Tooltip } from "../ui-toolkit/Tooltip"

// A panel's create button: a button set flush left across the panel.
export const sidebarCreateClasses =
  "button sidebar-create w-full shrink-0 justify-start px-2.5 text-left"

export const SidebarPanel = ({
  id,
  title,
  titleHint,
  count,
  active,
  onClose,
  children,
}: {
  id: string
  title: string
  titleHint?: string
  count?: number
  active: boolean
  onClose: () => void
  children: ReactNode
}): React.JSX.Element => (
  <section
    id={id}
    className="sidebar-panel absolute inset-x-3 top-3 bottom-0 flex min-h-0 min-w-0 flex-col opacity-100 visible [transform:translateX(0)] data-[active=false]:pointer-events-none data-[active=false]:invisible data-[active=false]:[transform:translateX(-6px)] data-[active=false]:opacity-0"
    data-active={active}
    aria-labelledby={`${id}-title`}
    aria-hidden={!active}
    inert={!active}
  >
    <header className="sidebar-panel-header flex h-[38px] shrink-0 items-center justify-between gap-3 px-0.5">
      <Tooltip content={titleHint} disabled={!titleHint}>
        <h2
          id={`${id}-title`}
          tabIndex={titleHint ? 0 : undefined}
          className="section-label m-0 flex min-w-0 items-center gap-1.5 text-label font-medium"
        >
          {title}
          {count !== undefined && <span className="sidebar-panel-count">{count}</span>}
        </h2>
      </Tooltip>
      <Tooltip content="Hide">
        <button
          className="icon-button dim sidebar-close size-7"
          type="button"
          aria-label={`Hide ${title.toLowerCase()}`}
          onClick={onClose}
        >
          <X size={15} strokeWidth={1.6} />
        </button>
      </Tooltip>
    </header>
    <div className="sidebar-panel-content flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
  </section>
)
