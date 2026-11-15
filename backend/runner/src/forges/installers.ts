import type { ForgeName } from "@novadeck/protocol"

const brew: Readonly<Record<ForgeName, string>> = {
  github: "gh",
  gitlab: "glab",
  azure: "azure-cli",
}

// Ids in the Windows Package Manager's community repository (microsoft/winget-pkgs).
const winget: Readonly<Record<ForgeName, string>> = {
  github: "GitHub.cli",
  gitlab: "GLab.GLab",
  azure: "Microsoft.AzureCLI",
}

/**
 * The command that installs a forge's tool on this platform, or undefined where there is
 * none: Homebrew on macOS where it is found, winget on Windows, nothing on Linux, where
 * the tool comes from the person's own package manager.
 */
export const installerFor = (
  forge: ForgeName,
  platform: NodeJS.Platform,
  hasBrew: boolean,
): string | undefined => {
  if (platform === "darwin") return hasBrew ? `brew install ${brew[forge]}` : undefined
  if (platform === "win32") return `winget install --id ${winget[forge]} -e`
  return undefined
}
