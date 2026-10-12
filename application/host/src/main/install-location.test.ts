import { describe, expect, it } from "../test"
import {
  dataHome,
  installedImage,
  installedImages,
  isInstalledImage,
  type InstallLocationHost,
} from "./install-location"

const home = "/home/me"
const host = (overrides: Partial<InstallLocationHost> = {}): InstallLocationHost => ({
  env: {},
  home,
  realpath: (path) => path,
  ...overrides,
})

const linked = (path: string): string | undefined =>
  path === "/link/novadeck.AppImage" ? "/home/me/Applications/novadeck.AppImage" : path

describe("the data folder", () => {
  it("is XDG_DATA_HOME when that is an absolute path", () => {
    expect(dataHome(host({ env: { XDG_DATA_HOME: "/data" } }))).toBe("/data")
  })

  it("is ~/.local/share when XDG_DATA_HOME is unset, empty or relative", () => {
    for (const XDG_DATA_HOME of [undefined, "", "data", "~/data"])
      expect(dataHome(host({ env: { XDG_DATA_HOME } }))).toBe("/home/me/.local/share")
  })
})

describe("where an AppImage is installed", () => {
  it("is the data folder for the installer, then ~/Applications for Homebrew", () => {
    expect(installedImage(host())).toBe("/home/me/.local/share/novadeck/novadeck.AppImage")
    expect(installedImages(host({ env: { XDG_DATA_HOME: "/data" } }))).toEqual([
      "/data/novadeck/novadeck.AppImage",
      "/home/me/Applications/novadeck.AppImage",
    ])
  })
})

describe("whether an AppImage is installed", () => {
  it("is when it is at either place", () => {
    for (const path of installedImages(host())) expect(isInstalledImage(path, host())).toBe(true)
  })

  it("is not anywhere else, such as Downloads", () => {
    expect(isInstalledImage("/home/me/Downloads/novadeck.AppImage", host())).toBe(false)
  })

  it("compares canonical paths, so a link to an install counts", () => {
    const realpath = linked
    expect(isInstalledImage("/link/novadeck.AppImage", host({ realpath }))).toBe(true)
  })

  it("is not when the file's canonical path cannot be had", () => {
    expect(isInstalledImage(installedImage(host()), host({ realpath: () => undefined }))).toBe(
      false,
    )
  })
})
