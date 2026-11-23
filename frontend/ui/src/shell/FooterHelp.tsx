import { watchPerson } from "@novadeck/core/person"
import { ContextMenu, type ContextMenuAction } from "@novadeck/toolkit/ContextMenu"
import { CircleHelp } from "lucide-react"
import { useEffect, useState } from "react"

import { readFirstUse, writeFirstUse } from "../interaction/first-use"

export const helpOpenedStorageKey = "novadeck.help-opened"
const readHelpOpened = (): boolean => readFirstUse(helpOpenedStorageKey)

/**
 * The footer's Help button, after the feedback button: a chip like it, pressed while its menu is
 * open. It shows its word, "Help", until the menu was first opened, and is the icon alone from
 * then on. The mark is written as the menu opens; the word goes once it has closed, so the chip
 * does not shrink under an open menu. The menu opens above it and lists `items`, which the app
 * gives.
 */
export const FooterHelp = ({
  items,
}: {
  readonly items: readonly ContextMenuAction[]
}): React.JSX.Element => {
  const [opened, setOpened] = useState(readHelpOpened)
  // Opened on another device is opened (core's person.ts).
  useEffect(
    () =>
      watchPerson((key) => {
        if (key === "help-opened") setOpened(readHelpOpened())
      }),
    [],
  )
  return (
    <ContextMenu
      label="Help"
      opensOn="click"
      tooltip="Help"
      items={items}
      onOpenChange={(open) => {
        if (open) writeFirstUse(helpOpenedStorageKey)
        else setOpened(true)
      }}
      trigger={
        <button
          type="button"
          className="footer-update cursor-pointer"
          // Named always: narrow footers hide the word, and the name matches it where shown.
          aria-label="Help"
        >
          <CircleHelp size={12} strokeWidth={1.75} aria-hidden="true" />
          {!opened && <span className="footer-chip-text max-[701px]:hidden">Help</span>}
        </button>
      }
    />
  )
}
