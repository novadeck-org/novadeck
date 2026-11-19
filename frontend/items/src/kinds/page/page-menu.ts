import type { ContextMenuAction, ContextMenuItem } from "@novadeck/toolkit/ContextMenu"
import { webAddress, type PageEdit, type PageMenu, type Place } from "@novadeck/viewers/browser"

// The menu a page in a pane offers in place of the browser's own, from what's where the person
// asked for it: in a field, its edits; on a selection, Copy; on a link, its address to copy,
// and an http(s) one to open in their browser; then opening the page itself in their browser.
// Going back, forward, reloading and the page's address are the pane's own, in its toolbar and address bar.
// Each group sets itself apart from the one before. What a later feature offers on the same
// spot, as Comment on this, goes first, as `leading`: its own group, above the rest.

export type PageMenuActions = {
  readonly edit: (edit: PageEdit) => void
  // Puts text on the clipboard.
  readonly copy: (text: string) => void
  // Opens an address in the person's browser.
  readonly open: (url: string) => void
}

export const pageMenuItems = ({
  menu,
  live,
  place,
  actions,
  leading = [],
}: {
  readonly menu: PageMenu
  // Whether the page is live, not a snapshot, which has no edits.
  readonly live: boolean
  readonly place: Place
  readonly actions: PageMenuActions
  readonly leading?: readonly ContextMenuItem[]
}): ContextMenuItem[] => {
  const edits: ContextMenuAction[] = !live
    ? []
    : menu.editable
      ? [
          { value: "cut", label: "Cut", edit: "cut" as const },
          { value: "copy", label: "Copy", edit: "copy" as const },
          { value: "paste", label: "Paste", edit: "paste" as const },
          { value: "select-all", label: "Select all", edit: "selectAll" as const },
        ].map(({ value, label, edit }) => ({
          value,
          label,
          disabled: !menu.can[edit],
          onSelect: () => actions.edit(edit),
        }))
      : menu.selection !== ""
        ? [{ value: "copy", label: "Copy", onSelect: () => actions.edit("copy") }]
        : []
  const link = menu.link
  const links: ContextMenuAction[] = link
    ? [
        { value: "copy-link", label: "Copy link address", onSelect: () => actions.copy(link) },
        ...(webAddress(link)
          ? [
              {
                value: "open-link",
                label: "Open link in your browser",
                onSelect: () => actions.open(link),
              },
            ]
          : []),
      ]
    : []
  const own: ContextMenuAction[] = [
    {
      value: "open-page",
      label: "Open page in your browser",
      onSelect: () => actions.open(place.url),
    },
  ]
  return [leading, edits, links, own]
    .filter((group) => group.length > 0)
    .flatMap((group, index) =>
      group.map((item, at) =>
        index > 0 && at === 0 && !("items" in item) ? { ...item, separated: true } : item,
      ),
    )
}
