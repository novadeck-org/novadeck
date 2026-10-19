// Where an item's row is on the page: its sheet sits beside it, and the keyboard follows it.
export const rowOf = (id: string | null): HTMLElement | null =>
  id === null
    ? null
    : (Array.from(document.querySelectorAll<HTMLElement>("[data-inbox-item]")).find(
        (element) => element.dataset.inboxItem === id,
      ) ?? null)

const controls =
  'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

// The controls of the sheet's page in tab order, not the buttons of its title bar, which
// come before them. The first is where Tab from its row lands.
export const sheetControls = (sheet: ParentNode = document): HTMLElement[] => {
  const page = sheet.querySelectorAll<HTMLElement>(
    `.inbox-sheet-scroll :is(${controls}), .inbox-sheet-footer :is(${controls})`,
  )
  return Array.from(page)
}

// Moves focus to the first control of the open sheet; false where there is none yet.
export const focusSheet = (): boolean => {
  const first =
    sheetControls()[0] ?? document.querySelector<HTMLElement>(".inbox-sheet-head button")
  first?.focus()
  return first !== undefined && first !== null
}

// Focus for a sheet just opened from the keyboard, once it has mounted: its title, which
// does nothing, so a key pressed twice on a row answers nothing; Tab goes on to the controls.
export const focusSheetSoon = (frames = 12): void => {
  requestAnimationFrame(() => {
    const title = document.querySelector<HTMLElement>(".inbox-sheet-title")
    if (title) title.focus()
    else if (frames > 0) focusSheetSoon(frames - 1)
  })
}

// The select button of the row after an item's; none where it is the last.
export const nextRowButton = (id: string): HTMLElement | null => {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-inbox-item]"))
  const at = rows.findIndex((row) => row.dataset.inboxItem === id)
  const row = rows[at + 1]
  return row?.querySelector<HTMLElement>(".inbox-row-select") ?? null
}
