import type { MenuItemConstructorOptions } from "electron"

/**
 * The View menu: Electron's default (reload, developer tools, full screen) without its
 * zoom items, whose accelerators would zoom the page by Chromium's own steps, per site, and
 * lose what the terminals read in Ctrl+- and Ctrl+0. The app's scale is Preferences'.
 */
export const viewMenu: MenuItemConstructorOptions = {
  label: "View",
  submenu: [
    { role: "reload" },
    { role: "forceReload" },
    { role: "toggleDevTools" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ],
}

/**
 * The application menu on Linux: Electron's default (File, Edit, View without zoom and Window, each by
 * its role) with a Quit of its own. The default Quit, Ctrl+Q, quits without telling the
 * app it was the person who asked, which looks like the quit Electron makes of SIGTERM, a
 * desktop logout's; the app installs an update on the first and not on the second, see
 * ../updates/updater.ts. This Quit keeps the same accelerator and calls `quit`, which marks the quit
 * as the person's. The menu bar is hidden, but its accelerators still work.
 */
export const linuxMenu = (quit: () => void): MenuItemConstructorOptions[] => [
  { label: "File", submenu: [{ label: "Quit", accelerator: "CommandOrControl+Q", click: quit }] },
  { role: "editMenu" },
  viewMenu,
  { role: "windowMenu" },
]

/**
 * The application menu on Windows, hidden like Linux's: Electron's default menus by their
 * roles, the View without zoom, and no Help, whose links are Electron's.
 */
export const windowsMenu: MenuItemConstructorOptions[] = [
  { role: "fileMenu" },
  { role: "editMenu" },
  viewMenu,
  { role: "windowMenu" },
]

/**
 * The application menu on macOS: Electron's default, each menu by its role (the View without zoom), with Help
 * holding "Open Logs Folder", which shows the folder a bug report attaches.
 * Elsewhere the menu bar is hidden, so Preferences offers the same.
 */
export const macMenu = (openLogs: () => void): MenuItemConstructorOptions[] => [
  { role: "appMenu" },
  { role: "fileMenu" },
  { role: "editMenu" },
  viewMenu,
  { role: "windowMenu" },
  {
    role: "help",
    submenu: [{ label: "Open Logs Folder", click: openLogs }],
  },
]
