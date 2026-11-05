import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
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

// Repository-relative paths of the files in the working tree under `paths` (all of them when
// none): tracked and untracked alike, but not what .gitignore ignores or what was deleted and
// not yet `git rm`ed, so areas and links count the same files the folder scans read. NUL
// separated, so git doesn't quote a path with characters outside ASCII.
export const workingFiles = (repo: string, paths: string[] = []): string[] => [
  ...new Set(
    execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths],
      { cwd: repo, encoding: "utf8", maxBuffer: 1 << 26 },
    )
      .split("\0")
      .filter((file) => file !== "" && existsSync(join(repo, file))),
  ),
]
