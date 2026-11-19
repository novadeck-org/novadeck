import type { FolderMatch, Item, WroteFolder } from "@novadeck/core/items"
import { handleText } from "@novadeck/core/terminals/handle"

import { modifiedText } from "./model"
import { countText } from "./view-state"

// What a folder's path field suggests under the typed text, in groups: the pure rules.

export type SuggestionGroupId = "matches" | "shown" | "wrote" | "opened"

export type Suggestion = {
  // What opening it asks for, as it would be typed.
  readonly path: string
  readonly icon: "folder" | "pen"
  // The small text on the right: how many items, or who and when.
  readonly meta: string
}

export type SuggestionGroup = {
  readonly id: SuggestionGroupId
  // Absent for the matches, which sit right under the field.
  readonly label: string | undefined
  readonly suggestions: readonly Suggestion[]
}

// How many folders of each group made of items are offered.
export const offeredItems = 6

const labels: Record<SuggestionGroupId, string | undefined> = {
  matches: undefined,
  shown: "Shown by agents",
  wrote: "Agents wrote to, outside the project",
  opened: "You opened",
}

// The folders the session's items show, the latest first, once each, those `by` put there.
const foldersOf = (items: readonly Item[], by: Item["by"]): readonly Item[] => {
  const latest = items
    .filter((item) => item.kind === "folder" && item.by === by && item.path !== null)
    .toSorted((a, b) => b.shownAt - a.shownAt)
  return latest
    .filter((item, at) => latest.findIndex((each) => each.path === item.path) === at)
    .slice(0, offeredItems)
}

// The groups under the field, in their order, each only when it has something: the folders the
// typed text may be (`matches`), those agents showed and those the person opened (the session's
// `items`), and those agents wrote in outside the project (`wrote`). A folder the matches already
// name is not named twice.
export const suggestionGroups = ({
  matches,
  items,
  wrote,
  now,
}: {
  readonly matches: readonly FolderMatch[]
  readonly items: readonly Item[]
  readonly wrote: readonly WroteFolder[]
  readonly now: number
}): readonly SuggestionGroup[] => {
  const named = new Set(matches.map((match) => match.path))
  const shownBy = (by: Item["by"], meta: (item: Item) => string): readonly Suggestion[] =>
    foldersOf(items, by)
      .filter((item) => !named.has(item.path!))
      .map((item) => ({
        path: item.path!,
        icon: "folder" as const,
        meta: meta(item),
      }))
  const groups: SuggestionGroup[] = [
    {
      id: "matches",
      label: labels.matches,
      suggestions: matches.map((match) => ({
        path: match.path,
        icon: "folder",
        meta: match.open ? "open" : match.more ? `${match.count}+ items` : countText(match.count),
      })),
    },
    {
      id: "shown",
      label: labels.shown,
      suggestions: shownBy("agent", (item) =>
        [item.from && handleText(item.from.handle), modifiedText(item.shownAt, now)]
          .filter(Boolean)
          .join(" · "),
      ),
    },
    {
      id: "wrote",
      label: labels.wrote,
      suggestions: wrote
        .filter((folder) => !named.has(folder.path))
        .map((folder) => ({
          path: folder.path,
          icon: "pen",
          meta: `${handleText(folder.handle)} · ${folder.harness} · ${modifiedText(folder.at, now)}`,
        })),
    },
    {
      id: "opened",
      label: labels.opened,
      suggestions: shownBy("person", (item) => modifiedText(item.shownAt, now)),
    },
  ]
  return groups.filter((group) => group.suggestions.length > 0)
}

// What opening the text asks for: trimmed, without separators at its end (the root's own stays).
export const targetOf = (text: string): string => {
  const trimmed = text.trim()
  const stripped = trimmed.replace(/[\\/]+$/, "")
  return stripped === "" ? trimmed.slice(0, 1) : stripped
}

// A suggestion's path as completing it writes it, ready for what is inside it to be typed.
export const completion = (path: string): string =>
  /[\\/]$/.test(path) ? path : `${path}${path.includes("\\") && !path.includes("/") ? "\\" : "/"}`
