import type { Item } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"

import { registrationOf } from "../../registry"
import type { ItemStore } from "../../state"

// An item undocked into a window of its own: its registration's body, as in the pane, a
// plan editable, or something an agent showed loading from where it points now. The
// window's menu docks it back into the terminal it was shown from.
export const UndockedWindow = ({
  itemStore,
  target,
  item,
}: {
  itemStore: ItemStore
  target: WorkspaceTarget
  // Undefined while the backend hasn't reported it, or once it's gone, until the window
  // goes with it: the window shows nothing meanwhile.
  item: Item | undefined
}): React.JSX.Element => {
  const registration = item && registrationOf(item)
  const body = item && registration && (
    <registration.View item={item} itemStore={itemStore} target={target} actions={undefined} />
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
