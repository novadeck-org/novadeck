import { describe, expect, it } from "../test.js"
import { candidates, parseDevices } from "./devices.js"

const output = `Available devices:
  Vulkan0: Intel(R) Arc(tm) Graphics (MTL) (47803 MiB, 43023 MiB free) [igpu]
  Vulkan1: NVIDIA RTX 2000 Ada Generation Laptop GPU (NVK AD107) (8188 MiB, 7369 MiB free) [gpu]
  CPU: Intel(R) Core(TM) Ultra 9 185H (64000 MiB, 64000 MiB free) [cpu]
`

describe("listing devices", () => {
  it("reads each device's id, name, kind and memory", () => {
    expect(parseDevices(output)).toEqual([
      {
        id: "Vulkan0",
        name: "Intel(R) Arc(tm) Graphics (MTL)",
        kind: "igpu",
        totalMiB: 47803,
        freeMiB: 43023,
      },
      {
        id: "Vulkan1",
        name: "NVIDIA RTX 2000 Ada Generation Laptop GPU (NVK AD107)",
        kind: "gpu",
        totalMiB: 8188,
        freeMiB: 7369,
      },
      {
        id: "CPU",
        name: "Intel(R) Core(TM) Ultra 9 185H",
        kind: "cpu",
        totalMiB: 64000,
        freeMiB: 64000,
      },
    ])
  })

  it("skips the heading, blank lines and devices an unpatched engine lists without a kind", () => {
    expect(
      parseDevices("Available devices:\n\n  Vulkan0: Card (100 MiB, 90 MiB free)\r\nnoise\n"),
    ).toEqual([])
  })

  it("orders candidates integrated first, then dedicated, and never the CPU", () => {
    const devices = parseDevices(
      `  Vulkan0: Big (100 MiB, 90 MiB free) [gpu]\n  CPU: C (1 MiB, 1 MiB free) [cpu]\n  Vulkan1: Small (10 MiB, 9 MiB free) [igpu]\n  BLAS: B (1 MiB, 1 MiB free) [accel]\n  Vulkan2: Other (10 MiB, 9 MiB free) [gpu]`,
    )
    expect(candidates(devices).map((device) => device.id)).toEqual([
      "Vulkan1",
      "Vulkan0",
      "Vulkan2",
    ])
  })

  it("has no candidates without a GPU", () => {
    expect(candidates(parseDevices("  CPU: C (1 MiB, 1 MiB free) [cpu]"))).toEqual([])
  })
})
