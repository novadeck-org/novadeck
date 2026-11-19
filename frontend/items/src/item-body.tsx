import { kindRules } from "@novadeck/core/items"

import { lazyView } from "./lazy-view"
import type { ViewProps } from "./registration"
import { registrationOf } from "./registry"

// What a pane or a window shows of an item: its kind's body. A file's comes with what steps it
// through its folder (./file-steps.tsx), which loads only after the body: it adds its tools to
// the row and hears the keys of the pane or window around the body, and says nothing where the
// file is in no folder, or where its code couldn't load: the body shows all the same. `steps` is
// false where the item can't be pointed at another file, as in the project window, which keeps
// its own file.

const FileSteps = lazyView<ViewProps>(
  () => import("./file-steps").then((module) => module.FileSteps),
  null,
  "quiet",
)

export const ItemBody = ({
  item,
  itemStore,
  target,
  steps = true,
}: ViewProps & { readonly steps?: boolean }): React.JSX.Element => {
  const { View } = registrationOf(item)
  const body = <View item={item} itemStore={itemStore} target={target} />
  if (!steps || item.kind === "folder" || kindRules[item.kind].pointer !== "file") return body
  return (
    <>
      {body}
      <FileSteps item={item} itemStore={itemStore} target={target} />
    </>
  )
}
