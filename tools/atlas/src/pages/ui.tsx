import { useMemo, useState } from "react"

import { StackStrip } from "../components/stack.tsx"
import { Ground } from "../components/ui.tsx"
import { Detail, detailTitle } from "./ui/detail.tsx"
import { ModeSwitch, Picker, type Mode } from "./ui/lists.tsx"
import { lens, litFor, type Selection } from "./ui/model.ts"
import { Wiring } from "./ui/wiring.tsx"

import "./visual-tokens.css"
import "./ui/ui.css"

const Stat = ({ n, children }: { n: number; children: string }) => (
  <span className="flex items-baseline gap-1">
    <span className="font-mono text-body font-medium text-fg tabular-nums">{n}</span>
    {children}
  </span>
)

export const UiPage = () => {
  const [selection, setSelection] = useState<Selection>({ kind: "action", id: "terminal/add" })
  const [mode, setMode] = useState<Mode>("actions")
  const lit = useMemo(() => litFor(selection), [selection])
  const { totals } = lens
  const select = (next: Selection) => {
    setSelection(next)
    if (next?.kind === "action") setMode("actions")
    else if (next?.kind === "procedure")
      setMode(
        lens.procedures.find((p) => p.id === next.id)?.kind === "stream" ? "streams" : "procedures",
      )
  }
  return (
    <Ground
      flush
      title="UI"
      tools={
        <>
          <div className="pane floating flex h-9 items-center gap-4 px-3 text-caption text-muted">
            <Stat n={totals.actions}>actions</Stat>
            <Stat n={totals.reachingBackend}>reach the runner</Stat>
            <Stat n={totals.procedures}>calls and streams</Stat>
            <Stat n={totals.streams}>streams back</Stat>
          </div>
          <StackStrip token="frontend/ui" />
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3">
        <section className="pane shrink-0 px-3 py-2">
          <Wiring selection={selection} lit={lit} onSelect={(id) => select({ kind: "box", id })} />
        </section>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,2fr)_minmax(0,3fr)] gap-3">
          <section className="pane flex min-h-0 flex-col">
            <header className="pane-heading quiet flex h-11 shrink-0 items-center px-2">
              <ModeSwitch mode={mode} onMode={setMode} />
            </header>
            <Picker mode={mode} selection={selection} onSelect={select} />
          </section>
          <section className="pane floating flex min-h-0 flex-col">
            <header className="pane-heading quiet flex h-10 shrink-0 items-center gap-2 px-3">
              <h2 className="m-0 min-w-0 truncate font-mono text-body font-medium">
                {detailTitle(selection)}
              </h2>
            </header>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <Detail selection={selection} onSelect={select} />
            </div>
          </section>
        </div>
      </div>
    </Ground>
  )
}
