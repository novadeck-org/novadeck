import { statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

/**
 * A program found on the PATH by an absolute entry (never a relative one, never the working
 * folder), for a child to start by its full path: Windows searches a child's working folder
 * before the PATH, so a program of that name in the agent's own folder would otherwise run
 * with the runner's rights. Undefined where the PATH holds none.
 */
export const programPath = (name: string): string | undefined => {
  const file = process.platform === "win32" ? `${name}.exe` : name
  const path = process.env.PATH ?? process.env.Path ?? ""
  for (const folder of path.split(delimiter)) {
    if (folder === "" || !isAbsolute(folder)) continue
    const candidate = join(folder, file)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not here.
    }
  }
  return undefined
}
