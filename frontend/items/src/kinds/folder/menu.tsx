import type { FolderEntry } from "@novadeck/core/items"
import type { ContextMenuItem } from "@novadeck/toolkit/ContextMenu"
import { CodeXml, Copy, Eye, FolderOpen, PanelRight } from "lucide-react"

import { previewFor } from "../file/previews"

// Whether a file has a source to open on instead of what it looks like: its type has a preview
// with a switch to the source (as Markdown, HTML and data files do). A folder, a secret and a
// link out are never opened, so none has.
export const hasSource = (entry: FolderEntry): boolean =>
  entry.kind !== "folder" && !entry.secret && !entry.link && previewFor(entry.name) !== undefined

// Whether the quick look shows an entry: any file, held back or not (it then shows what the
// listing says of it, and reads nothing).
export const canLook = (entry: FolderEntry): boolean => entry.kind !== "folder"

const iconProps = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const

// What an entry's menu offers, from what the listing says of it. A secret and a link out are
// never opened, so they only copy their path. `actions` are what the view does for each.
export const entryMenu = (
  entry: FolderEntry,
  actions: {
    readonly open: () => void
    readonly openAsText: () => void
    readonly look: () => void
    readonly copyPath: () => void
  },
): ContextMenuItem[] => {
  const copy: ContextMenuItem = {
    value: "copy-path",
    label: "Copy path",
    icon: <Copy {...iconProps} />,
    separated: true,
    onSelect: actions.copyPath,
  }
  if (entry.secret || entry.link) return [{ ...copy, separated: false }]
  if (entry.kind === "folder")
    return [
      {
        value: "open",
        label: "Open",
        icon: <FolderOpen {...iconProps} />,
        detail: "Double-click",
        onSelect: actions.open,
      },
      copy,
    ]
  return [
    {
      value: "open",
      label: "Open",
      icon: <PanelRight {...iconProps} />,
      detail: "Double-click",
      onSelect: actions.open,
    },
    ...(hasSource(entry)
      ? [
          {
            value: "open-as-text",
            label: "Open as text",
            icon: <CodeXml {...iconProps} />,
            detail: "Alt+double-click",
            onSelect: actions.openAsText,
          },
        ]
      : []),
    {
      value: "quick-look",
      label: "Quick look",
      icon: <Eye {...iconProps} />,
      detail: "Space",
      onSelect: actions.look,
    },
    copy,
  ]
}
