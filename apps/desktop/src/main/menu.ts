import type { MenuItemConstructorOptions } from "electron"

/**
 * The application menu on Linux: Electron's default (File, Edit, View and Window, each by
 * its role) with a Quit of its own. The default Quit, Ctrl+Q, quits without telling the
 * app it was the person who asked, which looks like the quit Electron makes of SIGTERM, a
 * desktop logout's; the app installs an update on the first and not on the second, see
 * ./updater.ts. This Quit keeps the same accelerator and calls `quit`, which marks the quit
 * as the person's. The menu bar is hidden, but its accelerators still work.
 */
export const linuxMenu = (quit: () => void): MenuItemConstructorOptions[] => [
  { label: "File", submenu: [{ label: "Quit", accelerator: "CommandOrControl+Q", click: quit }] },
  { role: "editMenu" },
  { role: "viewMenu" },
  { role: "windowMenu" },
]

/**
 * The application menu on macOS: Electron's default, each menu by its role, with Help
 * holding "Open Logs Folder", which shows the folder a bug report attaches. Elsewhere the
 * menu bar is hidden, so Preferences offers the same.
 */
export const macMenu = (openLogs: () => void): MenuItemConstructorOptions[] => [
  { role: "appMenu" },
  { role: "fileMenu" },
  { role: "editMenu" },
  { role: "viewMenu" },
  { role: "windowMenu" },
  { role: "help", submenu: [{ label: "Open Logs Folder", click: openLogs }] },
]
