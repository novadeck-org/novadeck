import { clsx } from "clsx"
import type { ReactNode } from "react"

import { canvasPointer, GroundDots } from "./canvas-background.tsx"

// A page as one of Novadeck's windows: a pane on the recessed workspace, its heading
// carrying the selection bar, an optional sidebar of the app's chrome to its left.
export const Page = ({
  title,
  crumbs,
  tools,
  side,
  flush = false,
  children,
}: {
  title: ReactNode
  // What leads up to the title, such as "Areas /".
  crumbs?: ReactNode
  // Controls at the heading's end.
  tools?: ReactNode
  side?: ReactNode
  // Content that lays itself out edge to edge and scrolls itself, such as a canvas.
  flush?: boolean
  children: ReactNode
}) => (
  <div className="flex min-h-0 min-w-0 flex-1">
    {side}
    <div className="workspace dots relative flex min-w-0 flex-1 p-3">
      <section className="pane relative z-[1] flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="pane-heading flex h-12 shrink-0 items-center gap-3 px-4">
          {crumbs ? (
            <span className="flex shrink-0 items-center gap-1.5 text-body text-muted">
              {crumbs}
            </span>
          ) : null}
          <h1 className="m-0 min-w-0 truncate text-body font-medium">{title}</h1>
          {tools ? <div className="ml-auto flex shrink-0 items-center gap-3">{tools}</div> : null}
        </header>
        <div className={clsx("relative min-h-0 flex-1", flush ? "flex flex-col" : "overflow-auto")}>
          {flush ? children : <div className="px-5 py-5">{children}</div>}
        </div>
      </section>
    </div>
  </div>
)

// A page laid straight on the workspace, as the app's Canvas view lays out its windows:
// the ground with its dot grid, a floating chip naming the page, controls beside it.
export const Ground = ({
  title,
  crumbs,
  tools,
  side,
  flush = false,
  children,
}: {
  title: ReactNode
  crumbs?: ReactNode
  tools?: ReactNode
  side?: ReactNode
  // Content that lays itself out below the chip and scrolls itself.
  flush?: boolean
  children: ReactNode
}) => (
  <div className="flex min-h-0 min-w-0 flex-1">
    {side}
    <div className="workspace relative min-w-0 flex-1 overflow-hidden" {...canvasPointer}>
      <GroundDots />
      <div className={clsx("relative z-[1] flex h-full flex-col", !flush && "overflow-auto")}>
        <div className="flex shrink-0 items-center justify-between gap-3 p-3">
          <div className="pane floating flex h-9 min-w-0 items-center gap-1.5 px-3 text-body">
            {crumbs ? (
              <span className="flex shrink-0 items-center gap-1.5 text-muted">{crumbs}</span>
            ) : null}
            <h1 className="m-0 min-w-0 truncate text-body font-medium">{title}</h1>
          </div>
          {tools ? <div className="flex shrink-0 items-center gap-3">{tools}</div> : null}
        </div>
        {flush ? children : <div className="px-3 pb-3">{children}</div>}
      </div>
    </div>
  </div>
)

// A window standing on the workspace: a pane with a quiet heading.
export const Window = ({
  title,
  tools,
  className,
  children,
}: {
  title: ReactNode
  tools?: ReactNode
  className?: string
  children: ReactNode
}) => (
  <section className={clsx("pane flex min-w-0 flex-col", className)}>
    <header className="pane-heading quiet flex h-10 shrink-0 items-center gap-2 px-3">
      <h2 className="m-0 min-w-0 truncate text-body font-medium">{title}</h2>
      {tools ? <div className="ml-auto flex items-center gap-2">{tools}</div> : null}
    </header>
    <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
  </section>
)

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-muted italic">{children}</p>
)

export const Badge = ({ children, accent }: { children: ReactNode; accent?: boolean }) => (
  <span
    className={clsx(
      "badge inline-block px-1.5 text-[11px] leading-4",
      accent && "border-accent text-accent",
    )}
  >
    {children}
  </span>
)
