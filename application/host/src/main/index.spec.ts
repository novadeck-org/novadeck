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

    it("blocks renderer navigation and denies permissions by default", async () => {
      const main = await read("main/index.js")

      expect(main).toContain('webContents.on("will-navigate"')
      expect(main).toContain("setPermissionCheckHandler")
      expect(main).toContain("setPermissionRequestHandler")
    })
  })
})
