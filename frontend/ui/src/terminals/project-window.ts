import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"

// The session's project window: the person's own, titled by the file it shows, so it can't
// be renamed, and never docked or undocked.
export const isProjectWindow = (tile: Tile): boolean => isWindow(tile) && tile.home === "project"
