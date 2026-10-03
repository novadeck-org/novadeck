import { ArrowUpRight, Layers, Terminal, X } from "lucide-react"
import { useEffect, useRef } from "react"

import { isWindow } from "../model/roster"
import type { Tile } from "../model/types"
import { searchResultClasses } from "../ui-toolkit/SearchCombobox"

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
        className="overlay absolute inset-0"
        onPointerDown={mode === "click" ? onClose : undefined}
      />
      <section
        role="dialog"
        aria-label="Terminal switcher"
        aria-modal={mode === "click"}
        data-state="open"
        className="modal relative flex max-h-[calc(84dvh-20px)] w-full max-w-130 flex-col overflow-hidden"
        onKeyDown={(event) => {
          if (mode !== "click" || event.key !== "Tab" || event.ctrlKey) return
          event.preventDefault()
          if (document.activeElement === close.current) listbox.current?.focus()
          else close.current?.focus()
        }}
      >
        <header className="modal-header switcher-header flex min-h-17 shrink-0 items-center gap-3 px-5 py-3">
          <Layers size={16} className="shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-sm font-medium">Switch terminal</h2>
            <p className="modal-description m-0 mt-0.5 truncate text-[10px]">{project}</p>
          </div>
          <span className="switcher-count shrink-0 text-[10px]">
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
                  <p className="switcher-process item-detail m-0 truncate text-[10px]">
                    {isWindow(terminal) ? "window" : terminal.process || terminal.command}
                  </p>
                </div>
                <ArrowUpRight size={14} aria-hidden="true" className="switcher-go" />
              </div>
            )
          })}
        </div>
        <footer className="modal-footer switcher-footer shrink-0 px-5 py-3 text-[10px]">
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
                Release <strong className="font-medium">Ctrl</strong> to switch
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
