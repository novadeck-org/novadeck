import { describe, expect, it } from "../../test"
import { detectSoftwareGraphics, softwareGraphicsOnly } from "./software"

const linux = { platform: "linux", arch: "x64" }
const windows = { platform: "win32", arch: "x64" }
const nvidia = { vendorId: 0x10de, deviceId: 0x28b8, active: true }
const intel = { vendorId: 0x8086, deviceId: 0x7d55, active: false }
const llvmpipe = { vendorId: 0x1_00_05, deviceId: 0, active: true }
const swiftshader = { vendorId: 0x1a_e0, deviceId: 0xc0_de, active: true }
const warp = { vendorId: 0x14_14, deviceId: 0x8c, active: true }

const info = (...gpuDevice: object[]) => ({ gpuDevice })

describe("softwareGraphicsOnly", () => {
  it("is true when every adapter draws on the processor", () => {
    expect(softwareGraphicsOnly(info(llvmpipe))).toBe(true)
    expect(softwareGraphicsOnly(info(swiftshader))).toBe(true)
    expect(softwareGraphicsOnly(info(warp))).toBe(true)
    expect(softwareGraphicsOnly(info(llvmpipe, swiftshader))).toBe(true)
  })

  it("is false when any adapter is real hardware", () => {
    expect(softwareGraphicsOnly(info(nvidia, intel))).toBe(false)
    expect(softwareGraphicsOnly(info(llvmpipe, intel))).toBe(false)
  })

  it("is false when unsure", () => {
    expect(softwareGraphicsOnly(undefined)).toBe(false)
    expect(softwareGraphicsOnly({})).toBe(false)
    expect(softwareGraphicsOnly(info())).toBe(false)
    expect(softwareGraphicsOnly(info({ vendorId: 0x15ad, deviceId: 0x405 }))).toBe(false)
    expect(softwareGraphicsOnly(info({ deviceId: 5 }))).toBe(false)
    // An adapter that identifies nothing is not known to be software.
    expect(softwareGraphicsOnly(info({ vendorId: 0, deviceId: 0 }))).toBe(false)
  })
})

describe("detectSoftwareGraphics", () => {
  it("reads the basic GPU info", async () => {
    const asked: string[] = []
    const app = {
      getGPUInfo: (type: "basic" | "complete") => {
        asked.push(type)
        return Promise.resolve(info(llvmpipe))
      },
    }
    expect(await detectSoftwareGraphics(app, windows)).toBe(true)
    expect(asked).toEqual(["basic"])
  })

  it("is false when the GPU is disabled outright and the query is rejected", async () => {
    const app = { getGPUInfo: () => Promise.reject(new Error("GPU access not allowed")) }
    expect(await detectSoftwareGraphics(app, windows)).toBe(false)
  })

  it("does not ask on Linux or macOS, where the answer cannot be trusted", async () => {
    const asked: string[] = []
    const app = {
      getGPUInfo: (type: "basic" | "complete") => {
        asked.push(type)
        return Promise.resolve(info(llvmpipe))
      },
    }
    expect(await detectSoftwareGraphics(app, linux)).toBe(false)
    expect(await detectSoftwareGraphics(app, { platform: "darwin", arch: "x64" })).toBe(false)
    expect(asked).toEqual([])
  })
})
