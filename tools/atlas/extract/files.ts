import { readdirSync } from "node:fs"
import { join } from "node:path"

const testFile =
  /(\.test\.|\.spec\.|\.e2e\.|\/e2e\/|\/testing\/|\/testing\.tsx?$|\/test\/|\/specs\/)/

// Where the frontend's source is: each package of the old UI, and the apps.
export const frontendSources = (repo: string): string[] =>
  ["frontend", "apps"].flatMap((folder) =>
    readdirSync(join(repo, folder)).flatMap((name) => sourceFiles(repo, `${folder}/${name}/src`)),
  )

// Repository-relative paths of the non-test source files under `dir`, sorted.
export const sourceFiles = (repo: string, dir: string): string[] =>
  readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
    .map((entry) => `${dir}/${entry.replaceAll("\\", "/")}`)
    .filter((file) => /\.tsx?$/.test(file) && !testFile.test(file))
    .toSorted()
