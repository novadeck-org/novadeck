import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"

import { atlas } from "../atlas-data.ts"
import { areaPath, flowPath, procedurePath, settingId, tablePath, toolPath } from "../links.ts"
import { Badge } from "./ui.tsx"

type Item = { kind: string; label: string; detail: string; to: string }

const items: Item[] = [
  ...atlas.areas.map((a) => ({ kind: "area", label: a.id, detail: a.purpose, to: areaPath(a.id) })),
  ...atlas.api.procedures.map((p) => ({
    kind: "procedure",
    label: p.id,
    detail: p.kind,
    to: procedurePath(p.id),
  })),
  ...atlas.data.tables.map((t) => ({
    kind: "table",
    label: t.name,
    detail: `${t.columns.length} columns`,
    to: tablePath(t.name),
  })),
  ...atlas.data.settings.map((s) => ({
    kind: "setting",
    label: `${s.group}.${s.key}`,
    detail: s.type,
    to: `/data#${encodeURIComponent(settingId(s.group, s.key))}`,
  })),
  ...atlas.agents.tools.map((t) => ({
    kind: "tool",
    label: t.name,
    detail: t.description.slice(0, 80),
    to: toolPath(t.name),
  })),
  ...atlas.flows.map((f) => ({ kind: "flow", label: f.title, detail: f.id, to: flowPath(f.id) })),
]

const match = (item: Item, terms: string[]) => {
  const haystack = `${item.kind} ${item.label} ${item.detail}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

// Mounted only while open, so every opening starts with an empty query.
export const Search = ({ open, onClose }: { open: boolean; onClose: () => void }) =>
  open ? <Dialog onClose={onClose} /> : null

// The focus restore a closing dialog has scheduled; shared by every open, so a new one
// cancels it before it can take focus from the new input.
let pendingRestore: number | undefined

const Dialog = ({ onClose }: { onClose: () => void }) => {
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const navigate = useNavigate()

  // Closing hands focus back to whatever had it before the dialog opened. It is deferred,
  // because focusing a button inside the Enter keydown would let that key press it; any
  // later open (a remount, or a quick reopen) cancels a restore still pending.
  const before = useRef<Element | null>(document.activeElement)
  useEffect(() => {
    clearTimeout(pendingRestore)
    input.current?.focus()
    const el = before.current
    return () => {
      pendingRestore = window.setTimeout(() => {
        if (el instanceof HTMLElement && el.isConnected) el.focus()
      })
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  useEffect(() => {
    list.current?.children[index]?.scrollIntoView({ block: "nearest" })
  }, [index])

  const results = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((item) => match(item, terms)).slice(0, 50)
  }, [query])

  const go = (item: Item | undefined) => {
    if (!item) return
    onClose()
    void navigate(item.to)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-[var(--color-scrim)] pt-24"
      onMouseDown={onClose}
    >
      <div
        className="pane floating h-fit max-h-[70vh] w-[560px] max-w-[92vw] overflow-hidden rounded-[var(--radius-popover)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          value={query}
          placeholder="Jump to…"
          className="h-11 w-full border-0 border-b border-line bg-transparent px-4 text-body outline-none placeholder:text-muted"
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setIndex(Math.min(index + 1, results.length - 1))
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setIndex(Math.max(index - 1, 0))
            } else if (e.key === "Enter") go(results[index])
          }}
        />
        <ul ref={list} className="m-0 max-h-[56vh] list-none overflow-auto p-1.5">
          {results.length === 0 ? <li className="px-3 py-2 text-muted">No matches</li> : null}
          {results.map((item, i) => (
            <li key={`${item.kind}:${item.label}:${item.to}`}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => go(item)}
                data-selected={i === index}
                className="item flex w-full items-center gap-2 px-2.5 py-1 text-left"
              >
                <span className="w-20 shrink-0">
                  <Badge>{item.kind}</Badge>
                </span>
                <span className="truncate font-mono text-[12px]">{item.label}</span>
                <span className="ml-auto truncate text-[12px] text-muted">{item.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
