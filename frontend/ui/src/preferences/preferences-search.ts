// Searching Preferences: every setting a page shows, by its name, the words under it and its
// page's name. The rows are read from the pages as they render, so what search finds is always
// what the pages hold, whatever the backend offers.

// A setting search can find: its name, the words that describe it, the page it is on, the
// section of the page that holds it ("" for none), and what it leads to (a row of the page).
export type PreferenceRow<Target> = {
  readonly label: string
  readonly description: string
  readonly page: string
  readonly section: string
  readonly target: Target
}

// The rows that hold every word of the query, in their name, description, section or page, as
// many as `limit`: those named by it first, then those it only describes. Each setting once, as
// a page may show one in two places.
export const matchRows = <Target>(
  query: string,
  rows: readonly PreferenceRow<Target>[],
  limit = 12,
): PreferenceRow<Target>[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const seen = new Set<string>()
  return rows
    .flatMap((row) => {
      const label = row.label.toLowerCase()
      const text = [label, row.description, row.section, row.page].join(" ").toLowerCase()
      if (!words.every((word) => text.includes(word))) return []
      const rank = label.startsWith(words[0]!)
        ? 0
        : words.every((word) => label.includes(word))
          ? 1
          : 2
      return [{ row, rank }]
    })
    .toSorted((a, b) => a.rank - b.rank)
    .map(({ row }) => row)
    .filter((row) => {
      const key = `${row.page}\n${row.section}\n${row.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}

// Text inside a row that isn't its name: what describes it, a state, a command, a control's
// value, a key.
const notName =
  ".settings-description, .settings-note, .settings-installer, .settings-command, button, kbd, select, [data-part=trigger], [role=status], [role=alert]"

// A row's name: its first words outside what describes it or acts on it.
const nameOf = (row: HTMLElement): string => {
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    if (text && !node.parentElement?.closest(notName)) return text
  }
  return ""
}

// The settings each page of `root` shows, read from its panels, but for the pages `skip` names:
// a row (`.settings-row`) or a set of choices (`.settings-fieldset`), with its name, what
// describes it (its description and its state's note) and the title of its section. A row with
// no name of its own, as an addon's Install, takes its section's; one marked data-search-skip,
// as a picture beside a choice, is no setting. A panel's id ends in its page's id, as Ark names a
// tab's content.
export const rowsOf = (
  root: HTMLElement,
  pageOf: (id: string) => string | undefined,
  skip: ReadonlySet<string> = new Set(),
): PreferenceRow<{ readonly page: string; readonly row: HTMLElement }>[] =>
  [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')].flatMap((panel) => {
    const id = panel.id.slice(panel.id.lastIndexOf("content-") + "content-".length)
    const page = pageOf(id)
    if (page === undefined || skip.has(id)) return []
    return [...panel.querySelectorAll<HTMLElement>(".settings-row, .settings-fieldset")].flatMap(
      (row) => {
        if (row.closest("[data-search-skip]")) return []
        const section =
          row.closest("section")?.querySelector(":scope > header h3")?.textContent?.trim() ?? ""
        const label = nameOf(row) || section
        if (!label) return []
        const description = [...row.querySelectorAll(".settings-description, .settings-note")]
          .map((part) => part.textContent ?? "")
          .join(" ")
        return [{ label, description, page, section, target: { page: id, row } }]
      },
    )
  })
