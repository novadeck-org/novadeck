import { join } from "node:path"

// The folder under the platform's app data folder where a launch keeps its data: the
// workspace database, the shell files agents run, the appearance and Chromium's own.
// Named alike on every platform, and apart from the product's name, "Novadeck", which
// Electron would use: a change of branding then never moves anyone's data. A
// development launch keeps its own, so it never rewrites an installed Novadeck's agent
// launchers or opens its database.
export const dataFolderName = ({ packaged }: { readonly packaged: boolean }): string =>
  packaged ? "novadeck" : "novadeck-dev"

/**
 * Where a launch keeps its logs: in a `logs` folder of its data folder, but on macOS in the
 * system's Logs folder (~/Library/Logs), under the data folder's name, so an installed and a
 * development copy never write the same file. A data folder given by --user-data-dir keeps its
 * logs inside it on every system, so a throwaway profile leaves nothing elsewhere.
 */
export const logsFolder = (launch: {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly userData: string
  readonly packaged: boolean
  readonly ownDataFolder: boolean
}): string =>
  launch.platform === "darwin" && !launch.ownDataFolder
    ? join(launch.home, "Library", "Logs", dataFolderName(launch))
    : join(launch.userData, "logs")
