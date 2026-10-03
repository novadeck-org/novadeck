import { ArrowUpRight, Layers, Terminal, X } from "lucide-react"
import { useEffect, useRef } from "react"

import { isWindow } from "../model/roster"
import type { Tile } from "../model/types"
import { searchResultClasses } from "../ui-toolkit/SearchCombobox"

import motion from "../ui-toolkit/ModalMotion.module.css"

export const TerminalSwitcher = ({
  terminals,
  selected,
  project,
  mode,
  onSelect,
  onClose,
}: {
  terminals: readonly Tile[]
  selected: string | undefined
  project: string
  mode: "held" | "click"
  onSelect: (id: string) => void
  onClose: () => void
}): React.JSX.Element => {
  const active = useRef<HTMLDivElement>(null)
  const listbox = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (mode === "click") listbox.current?.focus({ preventScroll: true })
  }, [mode])
  useEffect(() => {
    if (!selected) return
    active.current?.scrollIntoView?.({ block: "nearest" })
  }, [selected])

  return (
    <div
      className={`${mode === "held" ? "pointer-events-none " : ""}fixed inset-0 z-50 flex items-start justify-center px-5 pt-[16vh]`}
    >
      <div
        aria-hidden="true"
        data-state="open"
        className={`${motion.backdrop} absolute inset-0 bg-scrim backdrop-blur-[3px]`}
        onPointerDown={mode === "click" ? onClose : undefined}
      />
      <section
        role="dialog"
        aria-label="Terminal switcher"
        aria-modal={mode === "click"}
        data-state="open"
        className={`${motion.dialog} pointer-events-auto relative flex max-h-[calc(84dvh-20px)] w-full max-w-130 flex-col overflow-hidden rounded-popover border border-line-strong bg-paper shadow-modal`}
        onKeyDown={(event) => {
          if (mode !== "click" || event.key !== "Tab" || event.ctrlKey) return
          event.preventDefault()
          if (document.activeElement === close.current) listbox.current?.focus()
          else close.current?.focus()
        }}
      >
        <header className="flex min-h-17 shrink-0 items-center gap-3 border-b border-line px-5 py-3 text-muted">
          <Layers size={16} className="shrink-0 text-muted" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-sm font-medium text-ink">Switch terminal</h2>
            <p className="m-0 mt-0.5 truncate text-[10px] text-muted">{project}</p>
          </div>
          <span className="shrink-0 font-mono text-[10px] text-muted">
            {terminals.findIndex((terminal) => terminal.id === selected) + 1} / {terminals.length}
          </span>
          <button
            ref={close}
            className="icon-button"
            aria-label="Close terminal switcher"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div
          ref={listbox}
          role="listbox"
          aria-label="Recent terminals"
          aria-activedescendant={selected ? `recent-terminal-${selected}` : undefined}
          tabIndex={mode === "click" ? 0 : -1}
          className="flex min-h-0 max-h-[50vh] flex-col gap-1 overflow-y-auto p-2"
        >
          {terminals.map((terminal) => {
            const current = terminal.id === selected
            return (
              <div
                key={terminal.id}
                id={`recent-terminal-${terminal.id}`}
                ref={current ? active : undefined}
                role="option"
                aria-label={terminal.name}
                aria-selected={current}
                data-highlighted={current ? "" : undefined}
                onClick={() => onSelect(terminal.id)}
                className={searchResultClasses}
              >
                <Terminal size={15} strokeWidth={1.5} aria-hidden="true" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="m-0 truncate text-xs font-medium">{terminal.name}</p>
                  <p className="m-0 truncate font-mono text-[10px] text-muted">
                    {isWindow(terminal) ? "window" : terminal.process || terminal.command}
                  </p>
                </div>
                <ArrowUpRight
                  size={14}
                  aria-hidden="true"
                  className="opacity-25 transition-opacity duration-(--motion-feedback) ease-interface group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[highlighted]:opacity-100"
                />
              </div>
            )
          })}
        </div>
        <footer className="shrink-0 border-t border-line bg-shell px-5 py-3 text-[10px] text-muted">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span>
              {mode === "held" ? (
                <>
                  <kbd>Tab</kbd> / <kbd>↓</kbd>
                </>
              ) : (
                <kbd>↓</kbd>
              )}{" "}
              next
            </span>
            <span>
              {mode === "held" ? (
                <>
                  <kbd>Shift Tab</kbd> / <kbd>↑</kbd>
                </>
              ) : (
                <kbd>↑</kbd>
              )}{" "}
              previous
            </span>
            <span className="ml-auto">
              <kbd>Esc</kbd> close
            </span>
          </div>
          <p className="m-0 mt-2">
            {mode === "held" ? (
              <>
                Release <span className="font-medium text-ink">Ctrl</span> to switch
              </>
            ) : (
              <>
                <kbd>Enter</kbd> to switch
              </>
            )}
          </p>
        </footer>
      </section>
    </div>
  )
}
