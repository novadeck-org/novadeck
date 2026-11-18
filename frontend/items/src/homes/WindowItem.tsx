import { shellCounts } from "@novadeck/core/agents/shells"
import type { Item } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"

import { PaneChrome, PaneTitle, tabTip } from "../pane-row"
import { itemLook, registrationOf } from "../registry"
import type { ItemStore } from "../store/item-store"
import { useContent, usePlans } from "../store/use-item-store"

// An item in a window of its own, undocked or opened from Files: its title in the row on top,
// as a pane draws its one item, over its kind's body. Neither has tabs, a mark or buttons
// of a pane.
export const WindowItem = ({
  item,
  itemStore,
  target,
}: {
  item: Item
  itemStore: ItemStore
  target: WorkspaceTarget
}): React.JSX.Element => {
  const plans = usePlans(itemStore, item.kind === "plan" ? [item.id] : [])
  const { View } = registrationOf(item)
  // A shells item with a shell that failed tints its title, as a pane's tab.
  const load = useContent(itemStore, target, item)
  const failed =
    load?.state === "ready" &&
    load.content.kind === "shells" &&
    shellCounts(load.content.shells).failed > 0
  const { icon, name } = itemLook(item, { plans })
  return (
    <PaneChrome
      renderRow={(note) => (
        <PaneTitle
          icon={icon}
          name={name}
          look={{
            tip: tabTip(item, note.facts, { where: note.where }),
            origin: undefined,
            failed,
          }}
          gone={note.gone}
        />
      )}
    >
      <View item={item} itemStore={itemStore} target={target} />
    </PaneChrome>
  )
}
