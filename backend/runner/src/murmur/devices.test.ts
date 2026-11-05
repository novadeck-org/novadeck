import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { engineDirectory } from "@novadeck/murmur"

import { describe, expect, it } from "../test.js"
import { candidates, parseDevices } from "./devices.js"

// The engine's patch prints each device's line; the parser reads it. Only a built engine runs
// the patch, so this renders the line from the patch's own source and reads it back, and a
// change to the patch's format or arguments that the parser doesn't follow fails here.
const patch = readFileSync(
  join(dirname(engineDirectory), "patches", "list-device-types.patch"),
  "utf8",
)
const added = patch
  .split("\n")
  .filter((text) => text.startsWith("+") && !text.startsWith("+++"))
  .map((text) => text.slice(1))

/** The arguments split at the commas outside any brackets. */
const splitArguments = (text: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character === "(") depth++
    else if (character === ")") depth--
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

/**
 * The line the patch's printf prints for a device with these values and `kind`. It knows only
 * `%s`, `%zu` and `\n`, and a printf on one line: anything else fails here, to be taught.
 */
const printed = (kind: string): string => {
  const calls = added
    .map((text) => /^\s*printf\("((?:[^"\\]|\\.)*)",\s*(.*)\);\s*$/.exec(text))
    .filter((match) => match !== null)
  expect(calls, "the patch's printf lines").toHaveLength(1)
  const call = calls[0]!
  const values = new Map([
    ["ggml_backend_dev_name(dev)", "Vulkan0"],
    ["ggml_backend_dev_description(dev)", "Intel(R) Arc(tm) Graphics (MTL)"],
    ["total / MiB", "47803"],
    ["free / MiB", "43023"],
    ["type", kind],
  ])
  const args = splitArguments(call[2]!).map((arg) => {
    const value = values.get(arg)
    if (value === undefined) throw new Error(`The patch prints ${arg}, which this test can't fill.`)
    return value
  })
  const specifiers = call[1]!.match(/%(?:zu|s)/g) ?? []
  expect(specifiers).toHaveLength(args.length)
  let next = 0
  return call[1]!
    .replace(/\\n/g, "\n")
    .replace(/%(?:zu|s)/g, () => args[next++]!)
    .replace(/%%/g, "%")
}

/** The kinds the patch prints: its default and each type's. */
const printedKinds = [...patch.matchAll(/^\+.*\btype = "([^"]+)"/gm)].map((match) => match[1]!)

/** Each device type the patch names, with the kind it prints for it. */
const kindByType = Object.fromEntries(
  [...patch.matchAll(/^\+.*GGML_BACKEND_DEVICE_TYPE_(\w+):\s*type = "([^"]+)"/gm)].map((match) => [
    match[1]!,
    match[2]!,
  ]),
)

/** The kinds the parser reads; the rest are skipped. */
const known = ["cpu", "gpu", "igpu", "accel"]

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

  it("reads the line the engine's patch prints, for each kind it knows", () => {
    expect(printedKinds).toEqual(expect.arrayContaining(known))
    for (const kind of known) {
      expect(parseDevices(`Available devices:\n${printed(kind)}`)).toEqual([
        {
          id: "Vulkan0",
          name: "Intel(R) Arc(tm) Graphics (MTL)",
          kind,
          totalMiB: 47803,
          freeMiB: 43023,
        },
      ])
    }
  })

  it("skips the patch's lines for the kinds it doesn't know", () => {
    const unknown = printedKinds.filter((kind) => !known.includes(kind))
    expect(unknown).toEqual(expect.arrayContaining(["other"]))
    for (const kind of unknown) expect(parseDevices(printed(kind))).toEqual([])
  })

  it("prints each device type the parser knows as its own kind", () => {
    // Integrated GPUs are tried before dedicated ones, so a swapped kind tries the wrong card.
    expect(kindByType).toMatchObject({ CPU: "cpu", GPU: "gpu", IGPU: "igpu", ACCEL: "accel" })
  })

  it("has no candidates without a GPU", () => {
    expect(candidates(parseDevices("  CPU: C (1 MiB, 1 MiB free) [cpu]"))).toEqual([])
  })
})
