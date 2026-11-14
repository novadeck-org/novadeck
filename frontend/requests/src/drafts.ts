import type { Picks } from "@novadeck/core/conversation/picks"
import { useLayoutEffect, useRef, useState } from "react"

import type { Entries } from "./forms"

// What the person has put into a dialog and not sent: the words typed into a choices dialog's
// options, by option id; the picks on a dialog's questions and the page they are on; the entries
// of a form. A host that keeps them (the Inbox, across a sheet closed and opened again) gives
// them with the way to change them; else the dialog keeps its own, for as long as it is drawn.
export type DialogDraft = {
  readonly typed?: Readonly<Record<string, string>>
  readonly picks?: Picks
  readonly page?: number
  readonly entries?: Entries
}

export type Drafted = {
  readonly value: DialogDraft
  readonly onChange: (next: DialogDraft) => void
}

export const noDialogDraft: DialogDraft = {}

// Whether a draft holds anything the person put in.
export const drafted = (draft: DialogDraft | undefined): boolean =>
  draft !== undefined &&
  (Object.values(draft.typed ?? {}).some((text) => text.trim() !== "") ||
    Object.values(draft.picks ?? {}).some(
      (pick) => pick.options.length > 0 || pick.text.trim() !== "",
    ) ||
    Object.values(draft.entries ?? {}).some((entry) => entry.value !== ""))

// A dialog's draft, the host's where it keeps one, else the dialog's own. Changes made one after
// another in one event each build on the last, as the host's value is a render behind them.
export const useDraft = (
  given: Drafted | undefined,
): {
  readonly get: <K extends keyof DialogDraft>(key: K) => DialogDraft[K]
  readonly set: <K extends keyof DialogDraft>(key: K, value: DialogDraft[K]) => void
  // A change from what the part holds now, with the changes before it in the same event.
  readonly update: <K extends keyof DialogDraft>(
    key: K,
    change: (now: DialogDraft[K]) => DialogDraft[K],
  ) => void
} => {
  const [own, setOwn] = useState<DialogDraft>(noDialogDraft)
  const draft = given?.value ?? own
  const latest = useRef(draft)
  useLayoutEffect(() => {
    latest.current = draft
  })
  const set = <K extends keyof DialogDraft>(key: K, value: DialogDraft[K]): void => {
    const next = { ...latest.current, [key]: value }
    latest.current = next
    if (given) given.onChange(next)
    else setOwn(next)
  }
  return {
    get: (key) => draft[key],
    set,
    update: (key, change) => set(key, change(latest.current[key])),
  }
}
