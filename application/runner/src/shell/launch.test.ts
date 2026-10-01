import { describe, expect, it } from "../test.js"
import type { InstalledShell } from "./install.js"
import { shellLaunch } from "./integration.js"
import { shellPaths } from "./scripts.js"

const paths: InstalledShell = { ...shellPaths("C:\\data", "win32"), launcher: "C:\\data\\hook.cmd" }

describe("cmd's startup command", () => {
  it("reaches cmd as one command line, inner quotes and all", () => {
    const launch = shellLaunch(
      "C:\\Windows\\System32\\cmd.exe",
      paths,
      {},
      {
        startup: { command: 'git commit -m "fix it" && claude', file: "C:\\data\\resume\\x" },
      },
    )
    expect(launch.args).toBe('/s /k "git commit -m "fix it" && claude"')
    expect(launch.resumes).toBe(true)
  })

  it("is nothing without one", () => {
    expect(shellLaunch("cmd.exe", paths, {}).args).toEqual([])
  })
})
