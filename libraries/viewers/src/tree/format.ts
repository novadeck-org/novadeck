// Which data format a file's name says: kept apart from the parsers, so an app can tell a
// data file by its name without loading them.

export type DataFormat = "json" | "jsonl" | "yaml"

/** The data format a file's name says, if it's one the tree reads. */
export const dataFormatOf = (path: string): DataFormat | undefined => {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
  if (extension === "json") return "json"
  if (extension === "jsonl" || extension === "ndjson") return "jsonl"
  if (extension === "yaml" || extension === "yml") return "yaml"
  return undefined
}
