import { ArrowUpRight, Search, Terminal as TerminalIcon, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { isWindow } from "../model/roster"
import type { Tile } from "../model/types"
import { Dialog } from "../ui-toolkit/Dialog"
import { SearchCombobox } from "../ui-toolkit/SearchCombobox"

import motion from "../ui-toolkit/ModalMotion.module.css"

// What a result says of where it runs. A window runs nothing, so only its name finds it.
const detail = (tile: Tile): { readonly command: string; readonly directory: string } =>
  isWindow(tile) ? { command: "window", directory: "" } : tile

export const TerminalSearch = ({
  open,
  terminals,
  destination,
  onSelect,
  onClose,
  onExitComplete,
}: {
  open: boolean
  terminals: readonly Tile[]
  destination: string
  onSelect: (id: string) => void
  onClose: () => void
  onExitComplete?: () => void
}): React.JSX.Element => {
  const [query, setQuery] = useState("")
  const chosen = useRef<string | null>(null)
  useEffect(() => {
    if (open) chosen.current = null
  }, [open])
  const matches = terminals.filter((terminal) =>
    `${terminal.name} ${detail(terminal).directory}`.toLowerCase().includes(query.toLowerCase()),
  )
  const select = (id: string): void => {
    chosen.current = id
    setQuery("")
    onSelect(id)
  }
  const searchInput = useRef<HTMLInputElement>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(expanded) => {
        if (!expanded) onClose()
      }}
      label="Find a terminal"
      onExitComplete={onExitComplete}
      initialFocusEl={() => searchInput.current}
      finalFocusEl={() => {
        if (!chosen.current) return null
        const terminal = Array.from(document.querySelectorAll<HTMLElement>("[data-terminal]")).find(
          (element) => element.dataset.terminal === chosen.current,
        )
        return (
          terminal?.querySelector<HTMLElement>("[data-terminal-input], input") ??
          terminal?.querySelector<HTMLButtonElement>("button") ??
          null
        )
      }}
      backdropClassName={`${motion.backdrop} fixed inset-0 z-50 bg-scrim backdrop-blur-[3px]`}
      positionerClassName="fixed inset-0 z-50 flex items-start justify-center px-5 pt-[16vh]"
      className={`${motion.dialog} w-full max-w-130 overflow-hidden rounded-popover border border-line-strong bg-paper shadow-modal`}
    >
      <SearchCombobox
        label="Search terminals"
        placeholder="Find a terminal…"
        resultsLabel="Matching terminals"
        controlClassName="search-field"
        contentClassName="search-results"
        inputRef={searchInput}
        query={query}
        onQueryChange={setQuery}
        onSelect={select}
        leading={<Search size={18} />}
        trailing={
          <button className="icon-button" aria-label="Close search" onClick={onClose}>
            <X size={16} />
          </button>
        }
        empty={
          <p className="search-empty px-4 py-10 text-center text-xs text-muted">
            No terminals match “{query}”.
          </p>
        }
        items={matches.map((terminal) => ({
          value: terminal.id,
          label: terminal.name,
          content: (
            <>
              <TerminalIcon size={15} strokeWidth={1.5} />
              <span className="search-result-copy flex min-w-0 flex-1 flex-col gap-1">
                <strong className="truncate text-xs font-medium">{terminal.name}</strong>
                <small className="flex min-w-0 items-center gap-2 font-mono text-[10px] text-muted">
                  <span className="shrink-0">{detail(terminal).command}</span>
                  <span className="truncate border-l border-line pl-2">
                    {detail(terminal).directory}
                  </span>
                </small>
              </span>
              <ArrowUpRight
                size={14}
                className="search-result-action opacity-25 transition-opacity duration-(--motion-feedback) ease-interface group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[highlighted]:opacity-100"
              />
            </>
          ),
        }))}
      />
      <div className="search-footnote flex items-center justify-between border-t border-line bg-shell px-5 py-3 text-[10px] text-muted">
        <span>Open in {destination}</span>
        <span className="search-dismiss flex items-center gap-2">
          <kbd>esc</kbd> Close
        </span>
      </div>
    </Dialog>
  )
}
