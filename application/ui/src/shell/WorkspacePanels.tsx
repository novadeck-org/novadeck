import { Allotment, LayoutPriority, type AllotmentHandle } from "allotment"
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"

import { Dialog } from "../ui-toolkit/Dialog"
import { useDesktop } from "./desktop"

const storageKey = "novadeck.sidebar-width"
const defaultWidth = 228
const minWidth = 180
const maxWidth = 400

const readWidth = (): number => {
  try {
    const stored = Number(localStorage.getItem(storageKey))
    return Number.isFinite(stored) && stored >= minWidth && stored <= maxWidth
      ? stored
      : defaultWidth
  } catch {
    return defaultWidth
  }
}

export const WorkspacePanels = ({
  sidebar,
  collapsed,
  mobileOpen,
  onMobileOpenChange,
  mobileRail,
  mobileLabel,
  mobileFinalFocusEl,
  children,
}: {
  sidebar: ReactNode
  collapsed: boolean
  mobileOpen: boolean
  onMobileOpenChange: (open: boolean) => void
  mobileRail: ReactNode
  mobileLabel: string
  mobileFinalFocusEl: () => HTMLElement | null
  children: ReactNode
}): React.JSX.Element => {
  const desktop = useDesktop()
  const [preferred, setPreferred] = useState(readWidth)
  const [width, setWidth] = useState(preferred)
  const [motion, setMotion] = useState({ collapsed, active: false })
  if (motion.collapsed !== collapsed) setMotion({ collapsed, active: true })
  const container = useRef<HTMLDivElement>(null)
  const panels = useRef<AllotmentHandle>(null)
  useEffect(() => {
    if (!motion.active) return
    const duration =
      Number.parseFloat(
        getComputedStyle(container.current ?? document.documentElement).getPropertyValue(
          "--motion-state",
        ),
      ) || 180
    const timeout = window.setTimeout(
      () => setMotion((previous) => ({ ...previous, active: false })),
      duration + 50,
    )
    return () => window.clearTimeout(timeout)
  }, [motion])
  const remember = (value: number): void => {
    const next = Math.max(minWidth, Math.min(maxWidth, value))
    setPreferred(next)
    try {
      localStorage.setItem(storageKey, String(next))
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }
  const resize = (value: number): void => {
    setMotion((previous) => ({ ...previous, active: false }))
    const available = container.current?.clientWidth ?? 0
    const next = Math.max(minWidth, Math.min(maxWidth, available - 320, value))
    panels.current?.resize([next, available - next])
    remember(next)
  }

  if (!desktop || !sidebar) {
    return (
      <>
        {sidebar && (
          <Dialog
            open={mobileOpen}
            onOpenChange={onMobileOpenChange}
            label={mobileLabel}
            className="sidebar-drawer fixed top-15 bottom-7 left-0 flex w-[272px] max-w-full bg-shell text-ink shadow-panel"
            backdropClassName="sidebar-scrim"
            positionerClassName="sidebar-positioner"
            initialFocusEl={() =>
              document.querySelector<HTMLButtonElement>(
                '.sidebar-drawer [data-active="true"] .sidebar-close',
              )
            }
            finalFocusEl={mobileFinalFocusEl}
          >
            {mobileRail}
            {sidebar}
          </Dialog>
        )}
        {children}
      </>
    )
  }

  return (
    <div
      className={`workspace-panels relative min-h-0 min-w-0 flex-1${motion.active ? " sidebar-transition" : ""}`}
      ref={container}
      style={{ "--sidebar-expanded-width": `${preferred}px` } as CSSProperties}
    >
      <Allotment
        ref={panels}
        proportionalLayout={false}
        onDragStart={() => setMotion((previous) => ({ ...previous, active: false }))}
        onChange={(sizes) => setWidth(sizes[0] ?? preferred)}
        onDragEnd={(sizes) => remember(sizes[0] ?? preferred)}
        onReset={() => resize(defaultWidth)}
      >
        <Allotment.Pane
          className="workspace-sidebar-pane"
          minSize={minWidth}
          maxSize={maxWidth}
          preferredSize={preferred}
          priority={LayoutPriority.Low}
          visible={!collapsed}
        >
          <div
            className="sidebar-content h-full"
            hidden={collapsed && !motion.active}
            aria-hidden={collapsed}
            inert={collapsed}
          >
            {sidebar}
          </div>
        </Allotment.Pane>
        <Allotment.Pane
          className="workspace-main-pane"
          minSize={320}
          priority={LayoutPriority.High}
        >
          {children}
        </Allotment.Pane>
      </Allotment>
      {!collapsed && (
        <div
          className="sidebar-keyboard-resize pointer-events-none absolute inset-y-0 z-40 w-2 -translate-x-1/2"
          role="separator"
          aria-label="Resize sidebar"
          aria-controls="terminal-sidebar"
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          style={{ left: width }}
          onKeyDown={(event) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return
            const increment = event.shiftKey ? 32 : 8
            const target = {
              ArrowLeft: width - increment,
              ArrowRight: width + increment,
              Home: minWidth,
              End: maxWidth,
              Enter: defaultWidth,
            }[event.key]
            if (target === undefined) return
            event.preventDefault()
            resize(target)
          }}
        />
      )}
    </div>
  )
}
