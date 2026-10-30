import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const newest = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
    const path = join(dir, entry.name)
    return Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs)
  }, 0)

// The extractor reads the contract from the built protocol package, which reads the built
// wire and terminal libraries, and terminal the emulator; build each, the libraries first,
// when it is missing or older than its source. It runs the package's own build
// (`tsc -p tsconfig.build.json`) with the TypeScript the package resolves, through Node:
// not through pnpm, which may first run an install, and which is a different executable on
// Windows. The build's own output goes to stderr, so a failing build explains itself and
// stdout stays the caller's.
export const ensureBuilt = (repo: string): void => {
  let rebuilt = false
  // Each with a file its build writes: the emulator has no index, only its subpaths.
  for (const [name, folder, output] of [
    ["@novadeck/wire", "libraries/wire", "dist/index.js"],
    ["@novadeck/emulator", "libraries/emulator", "dist/screen.js"],
    ["@novadeck/terminal", "libraries/terminal", "dist/index.js"],
    ["@novadeck/protocol", "contract/protocol", "dist/index.js"],
  ] as const) {
    const root = join(repo, folder)
    const built = join(root, output)
    if (!rebuilt && existsSync(built) && statSync(built).mtimeMs >= newest(join(root, "src")))
      continue
    // What comes after a rebuilt package is rebuilt too, as it may depend on the one before.
    rebuilt = true
    process.stderr.write(`atlas: building ${name}…\n`)
    const typescript = createRequire(join(root, "package.json")).resolve("typescript/package.json")
    const tsc = join(dirname(typescript), "bin/tsc")
    // `--noEmitOnError`: a failed build leaves the old output stale, so the next call
    // rebuilds and fails again, instead of finding fresh output built from broken source.
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--noEmitOnError"], {
      cwd: root,
      stdio: ["ignore", 2, 2],
    })
  }
}
