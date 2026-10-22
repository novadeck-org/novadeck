import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"

// The session's project window: the person's own, titled by the file it shows, so it can't
// be renamed, and never docked or undocked.
export const isProjectWindow = (tile: Tile): boolean => isWindow(tile) && tile.home === "project"

// The folder of the file a project window shows, from its project's folder, as its tab's
// second line says it: `src/checkout`, nothing for a file at the project's root, and the
// whole folder for one outside the project.
export const projectFolder = (path: string | null, directory: string): string => {
  if (path === null) return ""
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  const folder = cut <= 0 ? path.slice(0, cut + 1) : path.slice(0, cut)
  const root = directory.replace(/[/\\]+$/, "")
  if (folder === root) return ""
  const inside = folder.startsWith(root) && /^[/\\]/.test(folder.slice(root.length))
  return inside ? folder.slice(root.length + 1) : folder
}
