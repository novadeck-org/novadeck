/** What finding the places an AppImage is installed to looks at of the machine. */
export type InstallLocationHost = {
  /** The environment; `XDG_DATA_HOME` is the part used. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** The canonical form of a path, or undefined when it cannot be had. */
  readonly realpath: (path: string) => string | undefined
}

/**
 * The folder per-user data goes to: `XDG_DATA_HOME`, unless it is not an absolute path,
 * which counts as unset, as the XDG specification says and `scripts/install/install.sh`
 * does, and then `~/.local/share`.
 */
export const dataHome = ({ env, home }: Pick<InstallLocationHost, "env" | "home">): string =>
  env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : `${home}/.local/share`

/**
 * Where the installer puts the AppImage, which is also the one place an installed copy
 * updates itself from and the sandbox profile names.
 */
export const installedImage = (host: Pick<InstallLocationHost, "env" | "home">): string =>
  `${dataHome(host)}/novadeck/novadeck.AppImage`

/**
 * The places an installed AppImage lives, the installer's own first, then the one
 * Homebrew's cask and AppImageLauncher use, `~/Applications/novadeck.AppImage`.
 */
export const installedImages = (host: Pick<InstallLocationHost, "env" | "home">): string[] => [
  installedImage(host),
  `${host.home}/Applications/novadeck.AppImage`,
]

/**
 * Whether the AppImage file `appImage` is at one of the installed places. Known limits:
 * AppImageLauncher keeps the original file name when it integrates a file into
 * `~/Applications`, so such a copy is not at an installed place and counts as portable; and an
 * `XDG_DATA_HOME` set only in a shell's rc file is not seen by a copy started from the menu,
 * which can make an installed copy look portable. Paths are compared canonically, so a
 * symlinked install counts; a file whose canonical path cannot be had is not at any of them.
 * An installed place that is not there has no canonical path, and never matches.
 */
export const isInstalledImage = (appImage: string, host: InstallLocationHost): boolean => {
  const running = host.realpath(appImage)
  return running !== undefined && installedImages(host).map(host.realpath).includes(running)
}
