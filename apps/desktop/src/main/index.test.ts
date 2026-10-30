import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { context, describe, expect, it } from "../test"

const output = join(process.cwd(), "out")
const read = (path: string): Promise<string> => readFile(join(output, path), "utf8")

describe("the compiled desktop app", () => {
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
      // Chromium's WebGL context limit is raised before the app is ready, and the window's
      // preload is told it; the switch itself is covered in ./graphics/webgl.test.ts.
      expect(main).toMatch(/raiseWebglContexts\(\s*app\.commandLine\s*\)/)
      expect(main).toContain("webglContextsArgument(")
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
      expect(main).toContain("murmurEngineArgumentPrefix")
      expect(main).toContain("murmurSourceArgumentPrefix")
      expect(main).toContain("graphicsArgumentPrefix")
      expect(main).toContain("MessageChannelMain")
      expect(main).toContain("senderFrame")
      expect(preload).toContain("novadeck:runner-port")
      expect(preload).toContain("requestRunner")
      // The main process takes only the broker from wire's `/electron`, not the preload's relay.
      expect(main).not.toContain("ipcRenderer")
      // The sandboxed preload may load nothing but electron.
      expect(new Set(preload.match(/require\("[^"]+"\)/g))).toEqual(
        new Set(['require("electron")']),
      )
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
      // Only the app's own windows: a look's, out of sight, has no page to save.
      expect(main).toContain("saveWindows(appWindows())")
      expect(main).toMatch(
        /appWindows = \(\) => BrowserWindow\.getAllWindows\(\)\.filter\(\(window\) => !looker\.is\(window\)\)/,
      )
      expect(main).toContain("() => saveWindows([window])")
      expect(main).toContain("saveBeforeQuitChannel")
      expect(preload).toContain("novadeck:save-before-quit")
      expect(preload).toContain("beforeQuit")
    })

    it("loads the updater only in a build that updates itself, and shuts down as quitting does before installing", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      // The decision itself is covered in ./updates/updater.test.ts.
      expect(main).toContain("updatePlan(")
      expect(main).toContain('await import("electron-updater")')
      expect(preload).toContain("novadeck:update-offer")
      expect(preload).toContain("novadeck:open-update-page")
      expect(preload).toContain("novadeck:set-update-channel")
      // electron-builder's portable Windows target is not shipped, and its variable is not read.
      expect(main).not.toContain("PORTABLE_EXECUTABLE_DIR")
    })

    it("takes the single-instance lock before anything starts, and brings the window forward for a second launch", async () => {
      const main = await read("main/index.js")

      expect(main).toContain("requestSingleInstanceLock()")
      expect(main).toContain('app.on("second-instance"')
      expect(main.indexOf("requestSingleInstanceLock()")).toBeLessThan(main.indexOf("whenReady()"))
      // A second launch says which data folder is taken before it quits.
      const refusal = main.slice(main.indexOf("if (!primaryInstance)"))
      expect(refusal.indexOf("console.error(")).toBeGreaterThan(-1)
      expect(refusal.indexOf("console.error(")).toBeLessThan(refusal.indexOf("app.exit(0)"))
      expect(refusal.slice(0, refusal.indexOf("app.exit(0)"))).toContain('getPath("userData")')
    })

    it("starts the installed AppImage as a detached child after letting go of the lock, never through app.relaunch", async () => {
      const main = await read("main/index.js")

      expect(main).toContain("releaseLock: () => app.releaseSingleInstanceLock()")
      // Exits through the helper that logs the launch's end first.
      // The bundler may rename `exitApp` where a module is handed it.
      expect(main).toMatch(/exit: \(\) => exitApp\d*\(0\)/u)
      expect(main).toContain('import { execFile, spawn } from "node:child_process"')
      // The lock goes first so the child can take it; the child is let go of before this one
      // exits. The bundler may rename `spawn`.
      expect(main).toMatch(
        /releaseLock\(\);[\s\S]*?spawn\d*\(file, args, \{\s*detached: true,\s*stdio: "ignore"[\s\S]*?child\.unref\(\);\s*exit\(\);/u,
      )
      // Electron's relaunch hands the child no-new-privileges, which stops an AppImage from
      // mounting; only macOS still uses it, and with the executable alone.
      expect(main).not.toContain("args: []")
      expect(main.match(/app\.relaunch\(/gu)).toHaveLength(1)
    })

    it("opens a window for a second launch when the app has none, as on macOS", async () => {
      const main = await read("main/index.js")
      const handler = main.slice(main.indexOf('app.on("second-instance"'))

      expect(handler.slice(0, handler.indexOf("\n});"))).toMatch(
        /bringForward\(window\);\s*else if \(server && !quitting\.stopping\) createWindow\(server\.origin\);\s*if \(process\.platform === "darwin"\) app\.focus\(\{ steal: true \}\)/u,
      )
    })

    it("opens the launch's records before it waits on anything, and ends them on every exit", async () => {
      const main = await read("main/index.js")
      const opened = main.indexOf("openSession(")
      expect(opened).toBeGreaterThan(-1)
      // Before the app is ready, and before the launch, whose first await comes early.
      expect(opened).toBeLessThan(main.indexOf("app.whenReady()"))
      expect(opened).toBeLessThan(main.indexOf("const launch = async"))
      // app.exit skips Node's exit event, so nothing calls it but the helper that logs the end.
      expect(main.match(/app\.exit\(/g)).toHaveLength(2)
    })

    it("reads installed versions with the environment the installed copy gets", async () => {
      const main = await read("main/index.js")

      expect(main).toMatch(
        /extractWithProcess\(installedEnvironment\(process\.env, appImageMounts\(\)\)\)/u,
      )
    })

    it("tells a portable copy of a newer installed one before the runner starts, and offers the install to the page", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      expect(main).toContain("await leaveForNewerInstalled(")
      const leaves = main.indexOf("await portableCopies.leaveForNewer(portable)")
      expect(leaves).toBeGreaterThan(-1)
      expect(leaves).toBeLessThan(main.indexOf("runner = startRunner("))
      // The signature is left out, so macOS never waits for codesign to open its window.
      expect(main).toMatch(
        /known = await build\.unsignedBuild\(\);\s*const portable = portableOf\(\{ \.\.\.known/u,
      )
      expect(main).not.toMatch(/portableOf\(await (?:build\.)?updateBuild\(\)\)/u)
      expect(main).toContain("registerPortableIpc(")
      expect(preload).toContain("novadeck:portable")
      expect(preload).toContain("novadeck:install-app")
      expect(preload).not.toContain("novadeck:open-installed")
    })

    it("copies to Applications only when the page asks to install, never quitting or relaunching for it, and opens release pages only from app-update.yml", async () => {
      const main = await read("main/index.js")

      // Linux's Ctrl+Q and Quit item mark the quit as the person's before quitting.
      expect(main).toContain("linuxMenu(")
      expect(main).toContain("Menu.setApplicationMenu")
      // Electron's move always quits and relaunches, which a portable copy must not do.
      expect(main).not.toContain("moveToApplicationsFolder")
      expect(main).toContain("isInApplicationsFolder")
      // No launch-time modal asks; the copy is the install of a portable copy.
      expect(main).not.toContain("Move Novadeck to your Applications folder?")
      expect(main).toMatch(/process\.platform === "darwin"\s*\? installMacBundle\(/u)
      expect(main).toContain("/usr/bin/ditto")
      expect(main).toContain("com.apple.quarantine")
      expect(main).toContain('"app-update.yml"')
      expect(main).not.toContain("novadeck-org/novadeck/releases/tag")
    })

    it("installs on Windows from a setup run while the app keeps running, detached and never through the shell", async () => {
      const main = await read("main/index.js")

      expect(main).toContain("installWindowsSetup(")
      expect(main).toContain("releaseLatestUrl(")
      expect(main).toContain("runSetup(")
      // Only a copy the installer did not make is portable, which the launch checks.
      expect(main).toContain("windowsInstalled")
      // The setup is never opened through the shell, which would apply SmartScreen. Only the
      // data folder is, for the person to look at.
      expect(main).not.toMatch(/shell\.openPath\((?!app\.getPath\("userData"\))/u)
      // The Windows copy, unlike Linux's, lets go of the lock inside startDetached.
      expect(main).toContain("startWindowsCopy")
      // Downloads go through Electron's network stack, which honours the system proxy.
      expect(main).toContain("net.fetch(")
    })

    it("opens windows on the page's last ground and follows its appearance", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      expect(main).toContain("appearance.json")
      // How launch restores the kept scheme is covered in ./window/appearance.test.ts.
      expect(main).toContain("restore(nativeTheme)")
      expect(main).toContain("nativeTheme.themeSource")
      expect(main).toContain("setBackgroundColor")
      expect(main).toContain("appearance.current()?.ground")
      expect(preload).toContain("novadeck:appearance")
      expect(preload).toContain("showAppearance")
    })

    it("tells the app's page of the requests a page in its view sees fail", async () => {
      const main = await read("main/index.js")
      const preload = await read("preload/index.cjs")

      // What it reports and skips is covered in the viewers' browser/host.test.ts.
      expect(main).toContain("watchPageRequests(")
      expect(main).toContain("novadeck:page-request")
      expect(preload).toContain("novadeck:page-request")
    })

    it("blocks renderer navigation and denies permissions but the app page's clipboard and microphone", async () => {
      const main = await read("main/index.js")

      expect(main).toContain('webContents.on("will-navigate"')
      expect(main).toContain("setPermissionCheckHandler")
      expect(main).toContain("setPermissionRequestHandler")
      // Which frames get the clipboard and the microphone is covered in ./window/permissions.test.ts.
      expect(main).toContain("limitPermissions(")
      expect(main).toContain("session.defaultSession")
      expect(main).toContain('askForMediaAccess("microphone")')
    })
  })
})
