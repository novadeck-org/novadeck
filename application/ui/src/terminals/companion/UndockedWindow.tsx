import type { CompanionItem } from "../../model/companion"
import type { WorkspaceTarget } from "../../model/types"
import { ArtifactTab, PlanTab } from "./CompanionPane"
import type { Panes } from "./state"

import "./companion.css"

// An item undocked into a window of its own: a plan, editable as in the pane, or
// something an agent showed, loading from where it points now. The window's menu docks it
// back into the terminal it was shown from.
export const UndockedWindow = ({
  panes,
  target,
  item,
}: {
  panes: Panes
  target: WorkspaceTarget
  // Undefined while the backend hasn't reported it, or once it's gone, until the window
  // goes with it: the window shows nothing meanwhile.
  item: CompanionItem | undefined
}): React.JSX.Element => (
  <div className="artifact-window">
    {!item ? null : item.kind === "plan" ? (
      <section className="plan-reader" data-workspace-companion aria-label="Plan">
        <PlanTab panes={panes} target={target} item={item} />
      </section>
    ) : (
      <ArtifactTab panes={panes} target={target} item={item} />
    )}
  </div>
)
