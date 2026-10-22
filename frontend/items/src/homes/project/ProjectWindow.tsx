import type { Item } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"

import { registrationOf } from "../../registry"
import type { ItemStore } from "../../state"

// The session's project window: the one file the person opened from Source, drawn as its
// kind draws it, code, a Markdown document, an image or the secrets gate. It is theirs, so
// it has no bar to dock back to and no actions of an agent's: only the body.
export const ProjectWindow = ({
  itemStore,
  target,
  item,
}: {
  itemStore: ItemStore
  target: WorkspaceTarget
  // Undefined while the backend hasn't reported it: the window shows nothing meanwhile.
  item: Item | undefined
}): React.JSX.Element => {
  const registration = item && registrationOf(item)
  return (
    <div className="artifact-window">
      {item && registration && (
        <registration.View item={item} itemStore={itemStore} target={target} actions={undefined} />
      )}
    </div>
  )
}
