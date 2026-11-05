import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const testFile =
  /(\.test\.|\.spec\.|\.e2e\.|\/e2e\/|\/testing\/|\/testing\.tsx?$|\/test\/|\/specs\/)/

// Where the frontend's source is: each package under `frontend/` and `apps/`. An entry with
// no `src` folder is no package: a stray file such as `.DS_Store`, or a folder a branch
// switch left behind with just its ignored node_modules.
export const frontendSources = (repo: string): string[] =>
  ["frontend", "apps"].flatMap((folder) =>
    readdirSync(join(repo, folder))
      .filter((name) =>
        statSync(join(repo, folder, name, "src"), { throwIfNoEntry: false })?.isDirectory(),
      )
      .flatMap((name) => sourceFiles(repo, `${folder}/${name}/src`)),
  )

// A file's name without its folder and extension.
export const stem = (file: string): string =>
  file
    .split("/")
    .at(-1)!
    .replace(/\.tsx?$/, "")

// Repository-relative paths of the non-test source files under `dir`, sorted.
export const sourceFiles = (repo: string, dir: string): string[] =>
  readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
    .map((entry) => `${dir}/${entry.replaceAll("\\", "/")}`)
    .filter((file) => /\.tsx?$/.test(file) && !testFile.test(file))
    .toSorted()
