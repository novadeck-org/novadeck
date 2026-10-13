import { clsx } from "clsx"
import type { ReactNode } from "react"

import { Segmented } from "../../components/viz.tsx"
import type { UiAction, UiProcedure } from "../../lens-ui.ts"
import {
  groupedActions,
  groupedProcedures,
  hasEffect,
  lens,
  nameOf,
  type Selection,
  streamBy,
} from "./model.ts"

export type Mode = "actions" | "procedures" | "streams"

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

type DotState = "on" | "soft" | "gap" | "off"

const Dot = ({ state, hue, title }: { state: DotState; hue: string; title: string }) => (
  <span
    className="up-dot"
    data-state={state}
    title={title}
    style={{ ["--_hue" as string]: `var(${hue})` }}
  />
)

// Three marks for an action: built in the UI, acted on by the runner adapter, sent back
// from a runner stream. Filled: traced. Faint fill: inferred from a state diff. Dashed:
// the scan looked and could not tell. Faint ring: nothing found.
export const PathDots = ({ action }: { action: UiAction }) => {
  const out: DotState = action.fromUi.length ? "on" : action.untraced ? "gap" : "off"
  const hasAction = action.effects.some((effect) => effect.basis === "action")
  const runner: DotState = hasAction ? "on" : hasEffect(action) ? "soft" : "off"
  const back: DotState = action.returns.length ? "on" : action.fromAdapter.length ? "gap" : "off"
  return (
    <span className="up-dots">
      <Dot
        state={out}
        hue="--g-ui"
        title={
          out === "on"
            ? "dispatched by the UI"
            : out === "gap"
              ? "no dispatch site found"
              : "not dispatched by the UI"
        }
      />
      <Dot
        state={runner}
        hue="--g-runner"
        title={
          hasAction
            ? "the adapter tests this action"
            : runner === "soft"
              ? "the adapter reacts to what it changes (inferred)"
              : "no adapter code reacts: only the every-commit save"
        }
      />
      <Dot
        state={back}
        hue="--h-codex"
        title={
          back === "on"
            ? "a runner stream dispatches it back"
            : back === "gap"
              ? "the adapter dispatches it, but no stream was traced to it"
              : "never dispatched by the adapter"
        }
      />
    </span>
  )
}

const Group = ({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) => (
  <section className="mb-2">
    <h3
      className="section-label sticky top-0 z-[1] m-0 flex items-baseline gap-2 px-2 py-1.5"
      style={{ background: "var(--color-paper)" }}
    >
      {title}
      <span className="count">{count}</span>
    </h3>
    <div className="flex flex-col gap-px">{children}</div>
  </section>
)

const Row = ({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: ReactNode
}) => (
  <button
    type="button"
    data-selected={selected}
    onClick={onClick}
    className="item flex h-7 items-center justify-between gap-2 px-2 text-left font-mono text-control"
  >
    {children}
  </button>
)

const ProcedureRow = ({
  procedure,
  selected,
  onSelect,
}: {
  procedure: UiProcedure
  selected: boolean
  onSelect: () => void
}) => {
  const stream = streamBy.get(procedure.id)
  return (
    <Row selected={selected} onClick={onSelect}>
      <span className="truncate">
        <span className="text-muted">{procedure.id.split(".")[0]}.</span>
        {procedure.id.split(".").slice(1).join(".")}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-caption text-muted">
        {procedure.kind === "stream" ? (
          stream?.dispatches.length ? (
            <span>{plural(stream.dispatches.length, "action")}</span>
          ) : stream?.feeds ? (
            <span className="max-w-32 truncate">{stream.feeds}</span>
          ) : (
            <span className="text-warning-fg">no store write found</span>
          )
        ) : procedure.actions.length ? (
          <span>{plural(procedure.actions.length, "action")}</span>
        ) : procedure.fromCommit ? (
          <span>every commit</span>
        ) : (
          <span>not from a commit</span>
        )}
      </span>
    </Row>
  )
}

export const ModeSwitch = ({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) => (
  <Segmented
    value={mode}
    onChange={onMode}
    options={[
      { id: "actions", label: `Actions ${lens.actions.length}` },
      {
        id: "procedures",
        label: `Calls ${lens.procedures.filter((p) => p.kind === "call").length}`,
      },
      { id: "streams", label: `Streams ${lens.streams.length}` },
    ]}
  />
)

export const Picker = ({
  mode,
  selection,
  onSelect,
}: {
  mode: Mode
  selection: Selection
  onSelect: (selection: Selection) => void
}) => (
  <div className="flex min-h-0 flex-1 flex-col">
    {mode === "actions" ? (
      <div className="flex shrink-0 items-center gap-3 px-3 pb-2 text-caption text-muted">
        <span className="flex items-center gap-1.5">
          <Dot state="on" hue="--g-ui" title="" />
          UI builds it
        </span>
        <span className="flex items-center gap-1.5">
          <Dot state="on" hue="--g-runner" title="" />
          runner reacts
        </span>
        <span className="flex items-center gap-1.5">
          <Dot state="on" hue="--h-codex" title="" />
          comes back
        </span>
      </div>
    ) : null}
    <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
      {mode === "actions"
        ? groupedActions().map(([prefix, actions]) => (
            <Group key={prefix} title={`${prefix}/`} count={actions.length}>
              {actions.map((action) => (
                <Row
                  key={action.type}
                  selected={selection?.kind === "action" && selection.id === action.type}
                  onClick={() => onSelect({ kind: "action", id: action.type })}
                >
                  <span className={clsx("truncate", action.untraced && "text-warning-fg")}>
                    <span className="text-muted">{prefix}/</span>
                    {nameOf(action.type)}
                  </span>
                  <PathDots action={action} />
                </Row>
              ))}
            </Group>
          ))
        : groupedProcedures(mode === "streams" ? "stream" : "call").map(([ns, procedures]) => (
            <Group key={ns} title={ns} count={procedures.length}>
              {procedures.map((procedure) => (
                <ProcedureRow
                  key={procedure.id}
                  procedure={procedure}
                  selected={selection?.kind === "procedure" && selection.id === procedure.id}
                  onSelect={() => onSelect({ kind: "procedure", id: procedure.id })}
                />
              ))}
            </Group>
          ))}
    </div>
  </div>
)
