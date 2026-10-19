import type { CompanionItem } from "@novadeck/core/companion"
import type { WorkspaceTarget } from "@novadeck/core/types"

import type { ItemMember } from "./bar"
import type { PaneRegistration } from "./registration"
import { registry } from "./registry"
import type { Panes } from "./state"

// An item undocked into a window of its own: its registration's body, as in the pane, a
// plan editable, or something an agent showed loading from where it points now. The
// window's menu docks it back into the terminal it was shown from.
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
}): React.JSX.Element => {
  const registration: PaneRegistration<ItemMember> | undefined = item && registry[item.kind]
  const body = item && registration && (
    <registration.View
      member={{ kind: "item", key: item.id, item, placed: false, fresh: false }}
      panes={panes}
      target={target}
      actions={undefined}
    />
  )
  return (
    <div className="artifact-window">
      {!registration ? null : registration.windowLabel ? (
        <section
          className="plan-reader"
          data-workspace-companion
          aria-label={registration.windowLabel}
        >
          {body}
        </section>
      ) : (
        body
      )}
    </div>
  )
}
