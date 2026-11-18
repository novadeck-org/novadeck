import type { FolderContent } from "@novadeck/core/items"
import { Folder } from "lucide-react"

import { countText } from "./model"

// A folder's peek: its icon and how much it holds; its files are never read for it.
export const FolderThumb = ({ content }: { content: FolderContent }): React.JSX.Element => (
  <span className="peek-folder">
    <Folder size={18} strokeWidth={1.5} aria-hidden="true" />
    <span>{countText(content.total)}</span>
  </span>
)
