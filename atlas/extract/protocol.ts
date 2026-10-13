import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const newest = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
    const path = join(dir, entry.name)
    return Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs)
  }, 0)

// The extractor reads the contract from the built protocol package; build it when it is
// missing or older than its source. It runs the package's own build (`tsc -p
// tsconfig.build.json`) with the TypeScript the package resolves, through Node: not
// through pnpm, which may first run an install, and which is a different executable on
// Windows. The build's own output goes to stderr, so a failing build explains itself and
// stdout stays the caller's.
export const ensureProtocol = (repo: string): void => {
  const protocol = join(repo, "application/protocol")
  const built = join(protocol, "dist/index.js")
  if (existsSync(built) && statSync(built).mtimeMs >= newest(join(protocol, "src"))) return
  process.stderr.write("atlas: building @novadeck/protocol…\n")
  const typescript = createRequire(join(protocol, "package.json")).resolve(
    "typescript/package.json",
  )
  const tsc = join(dirname(typescript), "bin/tsc")
  // `--noEmitOnError`: a failed build leaves the old output stale, so the next call
  // rebuilds and fails again, instead of finding fresh output built from broken source.
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--noEmitOnError"], {
    cwd: protocol,
    stdio: ["ignore", 2, 2],
  })
}
