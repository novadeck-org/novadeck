import type { ContextMenuAction, ContextMenuItem } from "@novadeck/toolkit/ContextMenu"
import { webAddress, type PageEdit, type PageMenu, type Place } from "@novadeck/viewers/browser"

// The menu a page in a pane offers in place of the browser's own, from what's where the person
// asked for it: in a field, its edits; on a selection, Copy; on a link, its address to copy,
// and an http(s) one to open in their browser; then going back, forward or reloading; then the page's own address.
// Each group sets itself apart from the one before. What a later feature offers on the same
// spot, as Comment on this, goes first, as `leading`: its own group, above the rest.

export type PageMenuActions = {
  readonly edit: (edit: PageEdit) => void
  readonly back: () => void
  readonly forward: () => void
  readonly reload: () => void
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
  // Whether the page is live, not a snapshot, which has no edits or history.
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
  const history: ContextMenuAction[] = live
    ? [
        { value: "back", label: "Back", disabled: !place.back, onSelect: actions.back },
        { value: "forward", label: "Forward", disabled: !place.forward, onSelect: actions.forward },
        { value: "reload", label: "Reload", onSelect: actions.reload },
      ]
    : []
  const own: ContextMenuAction[] = [
    { value: "copy-page", label: "Copy page address", onSelect: () => actions.copy(place.url) },
    {
      value: "open-page",
      label: "Open page in your browser",
      onSelect: () => actions.open(place.url),
    },
  ]
  return [leading, edits, links, history, own]
    .filter((group) => group.length > 0)
    .flatMap((group, index) =>
      group.map((item, at) =>
        index > 0 && at === 0 && !("items" in item) ? { ...item, separated: true } : item,
      ),
    )
}
