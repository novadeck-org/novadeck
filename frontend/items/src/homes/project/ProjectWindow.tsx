import type { Item } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import type { ComponentType, ReactNode } from "react"

import type { ItemStore } from "../../store/item-store"
import { WindowItem } from "../WindowItem"

// The session's project window: the one file the person opened from Files, drawn as its
// kind draws it, code, a Markdown document, an image or the secrets gate. It is theirs, so
// it has no bar to dock back to and no actions of an agent's: only its title row and the body. A file opened
// to preview what the agents' work merges to is drawn by `Preview` instead, which is given
// the file as its kind draws it (`fallback`) to show where it has nothing to preview.
export const ProjectWindow = ({
  itemStore,
  target,
  item,
  Preview,
}: {
  itemStore: ItemStore
  target: WorkspaceTarget
  // Undefined while the backend hasn't reported it: the window shows nothing meanwhile.
  item: Item | undefined
  Preview?: ComponentType<{ readonly fallback: ReactNode }> | undefined
}): React.JSX.Element => {
  const file = item ? (
    <WindowItem item={item} itemStore={itemStore} target={target} steps={false} />
  ) : null
  return <div className="artifact-window">{Preview ? <Preview fallback={file} /> : file}</div>
}
