import type { SourceListing } from "@novadeck/core/source"

// A project's folders as a backend lists them, from the paths of its files: an entry ending in
// `/` is an empty folder, and `ignored` names the entries (files or folders) it ignores.
export const folderListings = (
  entries: readonly string[],
  ignored: readonly string[] = [],
): Map<string, SourceListing> => {
  const names = new Map<string, Map<string, boolean>>()
  const add = (folder: string, name: string, isFolder: boolean): void => {
    const inside = names.get(folder) ?? new Map<string, boolean>()
    inside.set(name, (inside.get(name) ?? false) || isFolder)
    names.set(folder, inside)
  }
  for (const entry of entries) {
    const parts = entry.replace(/\/$/, "").split("/")
    parts.forEach((name, index) =>
      add(parts.slice(0, index).join("/"), name, index < parts.length - 1 || entry.endsWith("/")),
    )
    if (entry.endsWith("/")) names.set(parts.join("/"), names.get(parts.join("/")) ?? new Map())
  }
  const skipped = new Set(ignored.map((path) => path.replace(/\/$/, "")))
  return new Map(
    [...names].map(([folder, inside]) => [
      folder,
      {
        entries: [...inside].map(([name, isFolder]) => ({
          name,
          folder: isFolder,
          ignored: skipped.has(folder === "" ? name : `${folder}/${name}`),
        })),
        truncated: false,
      },
    ]),
  )
}
