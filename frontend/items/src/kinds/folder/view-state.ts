// What the workspace keeps of a folder item before its view loads (see ./index.ts): how it is
// looked at, which the item store holds, and what its taskbar peek says it holds.

export type FolderLayout = "grid" | "list"
export type FolderSort = "newest" | "name" | "size"

// How a folder item is looked at: the folder it is in, as a path from its top ("" is the top,
// "/" between names), its layout and its sort.
export type FolderView = {
  readonly within: string
  readonly layout: FolderLayout
  readonly sort: FolderSort
}

export const defaultFolderView: FolderView = { within: "", layout: "grid", sort: "newest" }

// What a folder holds, in words.
export const countText = (count: number): string => `${count} ${count === 1 ? "item" : "items"}`
