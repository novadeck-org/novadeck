import { kindRules } from "@novadeck/core/items"
import {
  lazy,
  Suspense,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react"

import type { ViewProps } from "./registration"
import { registrationOf } from "./registry"

// What a pane or a window shows of an item: its kind's body. A file's is drawn with what steps
// it through its folder (./file-steps.tsx), which loads only after the body: it adds its tools
// to the row and hears the keys of the body, and says nothing where the file is in no folder.

// What answers a key pressed in the body once the steps have loaded and told the body of it.
export type Press = (event: KeyboardEvent) => void
export type OnKeys = Dispatch<SetStateAction<Press | undefined>>

const FileSteps = lazy(() =>
  import("./file-steps").then((module) => ({ default: module.FileSteps })),
)

export const ItemBody = ({ item, itemStore, target }: ViewProps): React.JSX.Element => {
  const { View } = registrationOf(item)
  const [press, onKeys] = useState<Press>()
  const body = <View item={item} itemStore={itemStore} target={target} />
  if (item.kind === "folder" || kindRules[item.kind].pointer !== "file") return body
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Hears keys of what it holds; it has no role of its own.
    <div className="item-body" onKeyDown={(event) => press?.(event)}>
      {body}
      <Suspense fallback={null}>
        <FileSteps item={item} itemStore={itemStore} target={target} onKeys={onKeys} />
      </Suspense>
    </div>
  )
}
