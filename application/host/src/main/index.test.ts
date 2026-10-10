import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { context, describe, expect, it } from "../test"

const output = join(process.cwd(), "out")
const read = (path: string): Promise<string> => readFile(join(output, path), "utf8")

describe("compiled desktop host", () => {
  context("after the production build", () => {
    it("keeps the application identity and starts the embedded HTTP server", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      expect(main).toContain('const appId = "dev.mzpk.novadeck"')
      // Which folder a launch keeps its data in is covered in ./data-folder.test.ts.
      expect(main).toMatch(/app\.setPath\(\s*"userData"/)
      expect(main).toContain("dataFolderName({ packaged: app.isPackaged })")
      expect(main).toContain('"novadeck-dev"')
      // A folder given by --user-data-dir, as the packaged smoke test gives, is kept.
      expect(main).toContain('app.commandLine.getSwitchValue("user-data-dir")')
      expect(main).toContain("startHttpServer")
      expect(main).toContain("port: 0")
      expect(main).toContain('join(process.resourcesPath, "ui", "index.html")')
      expect(main).toContain("loadFile")
      expect(main).toContain("additionalArguments")
      expect(preload).toContain('exposeInMainWorld("novadeck"')
      expect(preload).toContain("127.0.0.1")
    })

    it("runs the runner in a utility process and relays one port per request", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      expect(main).toContain("utilityProcess.fork")
      expect(main).toContain("runner.js")
      expect(main).toContain("voiceEngineArgumentPrefix")
      expect(main).toContain("voiceSourceArgumentPrefix")
      expect(main).toContain("MessageChannelMain")
      expect(main).toContain("senderFrame")
      expect(preload).toContain("novadeck:runner-port")
      expect(preload).toContain("requestRunner")
    })

    it("offers a folder picker parented to the requesting window", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      expect(main).toContain("ipcMain.handle(directoryPickerChannel")
      expect(main).toContain("showOpenDialog")
      expect(main).toContain("openDirectory")
      expect(main).toContain("createDirectory")
      expect(preload).toContain("novadeck:pick-directory")
      expect(preload).toContain("pickDirectory")
    })

    it("lets pages save before quitting or closing a window ends the runner's shells", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      expect(main).toContain('app.on("before-quit"')
      expect(main).toContain("saveWindows(BrowserWindow.getAllWindows())")
      expect(main).toContain("() => saveWindows([window])")
      expect(main).toContain("saveBeforeQuitChannel")
      expect(preload).toContain("novadeck:save-before-quit")
      expect(preload).toContain("beforeQuit")
    })

    it("loads the updater only in a build that updates itself, and shuts down as quitting does before installing", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      // The decision itself is covered in ./updater.test.ts.
      expect(main).toContain("updatePlan(")
      expect(main).toContain('await import("electron-updater")')
      expect(main).toContain("shutdown: shutDown")
      expect(main).toContain("quitAndInstall(")
      expect(preload).toContain("novadeck:update-offer")
      expect(preload).toContain("novadeck:install-update")
      expect(preload).toContain("novadeck:open-update-page")
      expect(preload).toContain("novadeck:set-update-channel")
      // The portable Windows build is gone, and its variable is not read.
      expect(main).not.toContain("PORTABLE_EXECUTABLE_DIR")
    })

    it("offers a move to Applications before the windows and the runner start, and opens release pages only from app-update.yml", async () => {
      const main = await read("main/index.js")

      // Linux's Ctrl+Q and Quit item mark the quit as the person's before quitting.
      expect(main).toContain("linuxMenu(")
      expect(main).toContain("Menu.setApplicationMenu")
      expect(main).toContain("moveToApplicationsFolder")
      expect(main).toContain("isInApplicationsFolder")
      expect(main.indexOf("await moveToApplications()")).toBeLessThan(main.indexOf("startRunner("))
      expect(main).toContain('"app-update.yml"')
      expect(main).not.toContain("mzpkdev/novadeck/releases/tag")
    })

    it("opens windows on the page's last ground and follows its appearance", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      expect(main).toContain("appearance.json")
      // How launch restores the kept scheme is covered in ./appearance.test.ts.
      expect(main).toContain("restore(nativeTheme)")
      expect(main).toContain("nativeTheme.themeSource")
      expect(main).toContain("setBackgroundColor")
      expect(main).toContain("appearance.current()?.ground")
      expect(preload).toContain("novadeck:appearance")
      expect(preload).toContain("showAppearance")
    })

    it("blocks renderer navigation and denies permissions but the app page's clipboard and microphone", async () => {
      const main = await read("main/index.js")

      expect(main).toContain('webContents.on("will-navigate"')
      expect(main).toContain("setPermissionCheckHandler")
      expect(main).toContain("setPermissionRequestHandler")
      // Which frames get the clipboard and the microphone is covered in ./permissions.test.ts.
      expect(main).toContain("limitPermissions(")
      expect(main).toContain("session.defaultSession")
      expect(main).toContain('askForMediaAccess("microphone")')
    })
  })
})
