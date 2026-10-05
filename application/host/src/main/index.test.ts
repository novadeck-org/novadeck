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

    it("blocks renderer navigation and denies permissions but the app page's clipboard", async () => {
      const main = await read("main/index.js")

      expect(main).toContain('webContents.on("will-navigate"')
      expect(main).toContain("setPermissionCheckHandler")
      expect(main).toContain("setPermissionRequestHandler")
      // Which frames get the clipboard is covered in ./permissions.test.ts.
      expect(main).toContain("limitPermissions(session.defaultSession, isAppPage)")
    })
  })
})
