import { CircleDashed } from "lucide-react"

import { shortReasons, Unavailable } from "../../ArtifactViewer"
import type { ItemProps, ItemRegistration } from "../../registration"

// What this build has for an item of a kind a newer Novadeck shows: its name, and that it
// needs a newer Novadeck to show it. Nothing is loaded for it.
const NewerView = ({ item }: ItemProps): React.JSX.Element => (
  <div className="artifact-viewer">
    <Unavailable item={item} reason="newer" size={null} />
  </div>
)

const NewerThumb = (): React.JSX.Element => <span className="peek-held">{shortReasons.newer}</span>

export const newer = {
  kind: "newer",
  names: { one: "item", many: "Items" },
  icon: () => CircleDashed,
  stackIcon: CircleDashed,
  look: (item) => ({ name: item.name, label: `${item.name}, which needs a newer Novadeck` }),
  Thumb: NewerThumb,
  View: NewerView,
} satisfies ItemRegistration<"newer">
