import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// The page's styles and scripts, which several packages hold, for the checks that read them all.
// A file of this package is named by its path below src/; a file of another, as its package
// exports it: `@novadeck/<package>/<path below its src/>`, the name a stylesheet's `@import` uses.
const src = join(process.cwd(), "src")
const packages = [
  "chat",
  "core",
  "demo",
  "demo-debug",
  "items",
  "runner-adapter",
  "terminal-views",
  "toolkit",
]
const folderOf = (name: string): string => join(src, "..", "..", name, "src")
const listed = (folder: string): string[] =>
  (readdirSync(folder, { recursive: true }) as string[]).map((file) => file.split("\\").join("/"))

export const sources: readonly string[] = [
  ...listed(src),
  ...packages.flatMap((name) => listed(folderOf(name)).map((file) => `@novadeck/${name}/${file}`)),
]

// The package a file name belongs to, among the packages read; none for this package's own.
export const packageOf = (file: string): string | undefined =>
  packages.find((name) => file.startsWith(`@novadeck/${name}/`))

export const read = (file: string): string => {
  const name = packageOf(file)
  return readFileSync(
    name ? join(folderOf(name), file.slice(`@novadeck/${name}/`.length)) : join(src, file),
    "utf8",
  )
}

// Where a file is in the repository, as the docs name another package's files.
export const repositoryPathOf = (file: string): string => {
  const name = packageOf(file)
  return name ? `frontend/${name}/src/${file.slice(`@novadeck/${name}/`.length)}` : file
}
