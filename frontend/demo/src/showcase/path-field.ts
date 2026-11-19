import type { FolderMatch, Item, WroteFolder } from "@novadeck/core/items"

// What the demo's folder path field suggests, as the runner would: the folders a typed path may
// be, among a few the demo knows, and the folders outside the project its agents wrote in.

// The folders the demo's machine holds, by the path a person types for them, with how many
// entries each holds.
const known: readonly { readonly path: string; readonly count: number }[] = [
  { path: "~/Downloads", count: 34 },
  { path: "~/Downloads/storefront-assets", count: 12 },
  { path: "~/Documents", count: 58 },
  { path: "~/projects", count: 6 },
  { path: "~/projects/studio", count: 21 },
  { path: "~/projects/studio/public", count: 9 },
  { path: "~/projects/website", count: 17 },
  { path: "~/render", count: 7 },
  { path: "~/.cache", count: 14 },
  { path: "/tmp/render", count: 7 },
  { path: "/tmp/playwright-artifacts-Xk2Lq", count: 3 },
  { path: "/tmp/release-notes", count: 2 },
  { path: "/tmp/checkout-copy", count: 5 },
]

// The parent of a path as typed: its text up to the last separator, and the rest.
const split = (typed: string): { readonly before: string; readonly prefix: string } => {
  // "~" alone names the home folder's folders, as "~/" does.
  const text = typed === "~" ? "~/" : typed
  const last = text.lastIndexOf("/")
  return { before: text.slice(0, last + 1), prefix: text.slice(last + 1).toLowerCase() }
}

const parentOf = (path: string): string => {
  const last = path.lastIndexOf("/")
  return last <= 0 ? "/" : path.slice(0, last)
}

// The folders a typed path may be: those whose parent is the typed one and whose name starts as
// the typed last part does, by name, as the typed path would continue; a folder one of the
// session's `items` shows is open. A dot folder is named only by a path that starts one.
export const near = (typed: string, items: readonly Item[]): FolderMatch[] => {
  const open = new Set(
    items.flatMap((item) => (item.kind === "folder" && item.path ? [item.path] : [])),
  )
  if (typed.trim() === "") return []
  const { before, prefix } = split(typed)
  const parent = before === "" ? "~/projects/studio" : before.replace(/(?<=.)\/$/, "")
  return known
    .filter(({ path }) => parentOf(path) === parent)
    .map((folder) => ({ ...folder, name: folder.path.slice(folder.path.lastIndexOf("/") + 1) }))
    .filter(
      ({ name }) =>
        name.toLowerCase().startsWith(prefix) && (prefix.startsWith(".") || !name.startsWith(".")),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map(({ name, count, path }) => ({
      path: before + name,
      count,
      more: false,
      open: open.has(path),
    }))
}

const minute = 60_000

// The folders outside the project that agents wrote in, one by an agent of each harness, the
// latest first, as of `now`: what `companions.wroteTo` tells.
export const wrote = (now = Date.now()): WroteFolder[] => [
  { path: "/tmp/release-notes", handle: "moth", harness: "Codex", at: now - 4 * minute },
  { path: "/tmp/checkout-copy", handle: "owl", harness: "Claude Code", at: now - 6 * minute },
  {
    path: "~/.cache/storefront-probe",
    handle: "kite",
    harness: "Antigravity",
    at: now - 20 * minute,
  },
]
