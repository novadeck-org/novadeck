/** How this copy of the app was installed, as a log names it. */
export type InstallKind =
  | "development"
  | "appimage"
  | "linux-package"
  | "linux-unpacked"
  | "mac-applications"
  | "mac-elsewhere"
  | "windows-installer"
  | "windows-portable"

/** How this copy was installed, from what the update plan reads of the build. */
export const installKind = (build: {
  readonly packaged: boolean
  readonly platform: NodeJS.Platform
  readonly appImage: boolean
  readonly execPath: string
  readonly inApplications: boolean
  readonly windowsInstalled: boolean
}): InstallKind => {
  if (!build.packaged) return "development"
  if (build.platform === "darwin")
    return build.inApplications ? "mac-applications" : "mac-elsewhere"
  if (build.platform === "win32")
    return build.windowsInstalled ? "windows-installer" : "windows-portable"
  if (build.appImage) return "appimage"
  // A .deb or .rpm puts the app in /opt; anything else was unpacked by hand.
  return build.execPath.startsWith("/opt/") ? "linux-package" : "linux-unpacked"
}
