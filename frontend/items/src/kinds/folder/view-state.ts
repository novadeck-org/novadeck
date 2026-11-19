// What the workspace keeps of a folder item before its view loads (see ./index.ts): how it is
// looked at, which the item store holds, and what its taskbar peek says it holds.

export type FolderLayout = "grid" | "list"
export type FolderSort = "newest" | "name" | "size"

// How a folder item is looked at: the folder it is in, as a path from its top ("" is the top,
// "/" between names), its layout and its sort. `selected` is a file of that folder (by name)
// that something outside the view asks it to select, as a file's "Show in"; the view takes it
// as its selection and lets it go, so it is set only until the view has seen it.
export type FolderView = {
  readonly within: string
  readonly layout: FolderLayout
  readonly sort: FolderSort
  readonly selected?: string | undefined
}

export const defaultFolderView: FolderView = { within: "", layout: "grid", sort: "newest" }

// What a folder holds, in words.
export const countText = (count: number): string => `${count} ${count === 1 ? "item" : "items"}`
