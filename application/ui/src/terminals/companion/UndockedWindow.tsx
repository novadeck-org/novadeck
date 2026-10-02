import { useMemo } from "react"

import type { ArtifactContent, CompanionKey } from "../../model/companion"
import type { CompanionWindow } from "../../model/companion-items"
import { ArtifactViewer } from "./ArtifactViewer"
import { PlanTab } from "./CompanionPane"
import type { Shown } from "./pane"
import type { Panes } from "./state"
import { useArtifactContent, usePane } from "./use-panes"

import "./companion.css"

const LoadedArtifact = ({
  load,
  artifact,
}: {
  load: (artifact: Shown) => Promise<ArtifactContent>
  artifact: Shown
}): React.JSX.Element => (
  <ArtifactViewer artifact={artifact} load={useArtifactContent(load, artifact)} />
)

const ShownContent = ({
  panes,
  origin,
  window: { item, artifact: undocked },
}: {
  panes: Panes
  origin: CompanionKey
  window: CompanionWindow
}): React.JSX.Element => {
  const { pane, load } = usePane(panes, origin)
  const id = item.kind === "artifact" ? item.id : ""
  // As its terminal holds it now, so the agent showing it again updates it here; as it
  // was undocked once its terminal has it no longer.
  const live = pane.artifacts.find((shown) => shown.id === id)
  const shown = useMemo<Shown | undefined>(
    () => live ?? (undocked && { ...undocked, fresh: false, at: "" }),
    [live, undocked],
  )
  return shown ? (
    <LoadedArtifact load={load} artifact={shown} />
  ) : (
    <div className="artifact-status">The agent no longer shows this.</div>
  )
}

const PlanContent = ({
  panes,
  origin,
  plan: ref,
}: {
  panes: Panes
  origin: CompanionKey
  plan: string
}): React.JSX.Element => {
  const pane = usePane(panes, origin)
  const plan = pane.pane.plans.find((each) => each.ref === ref)
  return (
    <section className="plan-reader" data-workspace-companion aria-label="Plan">
      {plan ? (
        <PlanTab key={`${plan.ref}:${plan.writable}`} pane={pane} plan={plan} />
      ) : (
        <div className="artifact-status">The agent no longer keeps this plan.</div>
      )}
    </section>
  )
}

// A terminal's item undocked into a window of its own: a plan, editable as in the pane, or
// something its agent showed, loading from that terminal, `origin`. The window's menu
// docks it back there.
export const UndockedWindow = ({
  panes,
  origin,
  window,
}: {
  panes: Panes
  origin: CompanionKey
  window: CompanionWindow
}): React.JSX.Element => (
  <div className="artifact-window">
    {window.item.kind === "plan" ? (
      <PlanContent panes={panes} origin={origin} plan={window.item.ref} />
    ) : (
      <ShownContent panes={panes} origin={origin} window={window} />
    )}
  </div>
)
