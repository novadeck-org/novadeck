import type { IpcMainInvokeEvent } from "electron"

import { sandboxChannel } from "../bridge.js"
import { describe, expect, it } from "../test"
import { registerSandboxIpc, sandboxFix, sandboxState, type SandboxHost } from "./sandbox"

const repository = { owner: "novadeck-org", repo: "novadeck" }
const fix =
  "curl -fsSL https://github.com/novadeck-org/novadeck/releases/latest/download/install.sh | sh -s -- --sandbox"

const home = "/home/me"
const host = (overrides: Partial<SandboxHost> = {}): SandboxHost => ({
  platform: "linux",
  repository,
  restricted: "1\n",
  label: "unconfined\n",
  env: { APPIMAGE: `${home}/.local/share/novadeck/novadeck.AppImage` },
  home,
  realpath: (path) => path,
  ...overrides,
})
const installer = fix.replace(" -s -- --sandbox", "")

describe("the command that turns the sandbox on", () => {
  it("writes the profile for an AppImage at either place the installer puts it", () => {
    expect(sandboxFix(host())).toBe(fix)
    const env = { APPIMAGE: `${home}/Applications/novadeck.AppImage` }
    expect(sandboxFix(host({ env }))).toBe(fix)
  })

  it("follows XDG_DATA_HOME", () => {
    const env = { APPIMAGE: "/data/novadeck/novadeck.AppImage", XDG_DATA_HOME: "/data" }
    expect(sandboxFix(host({ env }))).toBe(fix)
  })

  it("compares canonical paths, so a symlinked install counts", () => {
    const realpath = (path: string): string | undefined =>
      path === "/link/novadeck.AppImage" ? `${home}/Applications/novadeck.AppImage` : path
    expect(sandboxFix(host({ env: { APPIMAGE: "/link/novadeck.AppImage" }, realpath }))).toBe(fix)
  })

  it("installs the AppImage where the profile applies when it runs from elsewhere", () => {
    const env = { APPIMAGE: `${home}/Downloads/novadeck.AppImage` }
    expect(sandboxFix(host({ env }))).toBe(installer)
    expect(sandboxFix(host({ env, realpath: () => undefined }))).toBe(installer)
  })

  it("treats a relative XDG_DATA_HOME as unset", () => {
    const env = {
      APPIMAGE: `${home}/.local/share/novadeck/novadeck.AppImage`,
      XDG_DATA_HOME: "data",
    }
    expect(sandboxFix(host({ env }))).toBe(fix)
  })

  it("is nothing when the installer's profile is already in effect", () => {
    for (const label of [
      "novadeck-appimage-1000 (unconfined)\n",
      "novadeck-appimage-1000-brew (enforce)",
      "novadeck-appimage-7",
    ])
      expect(sandboxFix(host({ label }))).toBeUndefined()
  })

  it("is still offered under another label or none", () => {
    for (const label of [
      "unconfined",
      "novadeck-other (enforce)",
      "xnovadeck-appimage-1000",
      undefined,
    ])
      expect(sandboxFix(host({ label }))).toBe(fix)
  })

  it("is nothing when the system does not restrict user namespaces", () => {
    expect(sandboxFix(host({ restricted: "0\n" }))).toBeUndefined()
    expect(sandboxFix(host({ restricted: undefined }))).toBeUndefined()
  })

  it("is nothing off Linux, without a repository, or outside an AppImage", () => {
    expect(sandboxFix(host({ platform: "darwin" }))).toBeUndefined()
    expect(sandboxFix(host({ repository: undefined }))).toBeUndefined()
    expect(sandboxFix(host({ env: {} }))).toBeUndefined()
  })
})

describe("whether the sandbox is on", () => {
  it("is on unless Electron was started without it", () => {
    expect(sandboxState(false, host())).toEqual({ sandboxed: true })
  })

  it("offers the fix when it is off", () => {
    expect(sandboxState(true, host())).toEqual({ sandboxed: false, fix })
  })

  it("offers no command when there is none that can work", () => {
    expect(sandboxState(true, host({ restricted: "0" }))).toEqual({ sandboxed: false, fix: "" })
  })
})

describe("taking the page's request for the sandbox", () => {
  const request = (own: boolean) => {
    let listener: ((event: IpcMainInvokeEvent) => unknown) | undefined
    registerSandboxIpc(
      {
        handle: (name, next) => {
          if (name === sandboxChannel) listener = next
        },
      },
      {
        window: () => (own ? "window" : undefined),
        state: () => Promise.resolve({ sandboxed: false, fix }),
      },
    )
    return listener?.({} as IpcMainInvokeEvent)
  }

  it("answers the app's own page", async () => {
    expect(await request(true)).toEqual({ sandboxed: false, fix })
  })

  it("tells any other sender the sandbox is on", () => {
    expect(request(false)).toEqual({ sandboxed: true })
  })
})
