import { describe, expect, it } from "vitest"

import type { GlReport } from "./gpu.ts"
import { lastDumps, memoryMarkdown, type MemorySample } from "./memory.ts"
import type { RunResult } from "./summary.ts"
import type { TraceEvent } from "./trace.ts"

const hex = (mb: number) => Math.round(mb * 1024 ** 2).toString(16)
const attrs = (size: number, effective?: number) => ({
  attrs: {
    size: { type: "scalar", units: "bytes", value: hex(size) },
    ...(effective !== undefined && {
      effective_size: { type: "scalar", units: "bytes", value: hex(effective) },
    }),
  },
})

const named = (pid: number, name: string): TraceEvent => ({
  name: "process_name",
  ph: "M",
  pid,
  tid: 0,
  ts: 0,
  args: { name },
})

// A global dump arrives as an event of totals and one of allocators a process.
const dump = (
  id: string,
  pid: number,
  footprint: number,
  allocators: Record<string, unknown>,
): TraceEvent[] => [
  {
    name: "periodic_interval",
    ph: "v",
    pid,
    tid: -1,
    ts: 1,
    id,
    args: { dumps: { process_totals: { private_footprint_bytes: hex(footprint) } } },
  },
  {
    name: "periodic_interval",
    ph: "v",
    pid,
    tid: -1,
    ts: 1,
    id,
    args: { dumps: { allocators } },
  },
]

describe("lastDumps", () => {
  const events: TraceEvent[] = [
    named(10, "GPU Process"),
    named(20, "Renderer"),
    ...dump("0x0", 10, 100, { "gpu/shared_images": attrs(10, 1) }),
    ...dump("0x1", 10, 150, {
      "gpu/shared_images": attrs(40, 2),
      "gpu/shared_images/client_0x6": attrs(40),
      "gpu/gl": attrs(8),
      "shared_memory/ABC": attrs(2),
      malloc: attrs(5),
    }),
    ...dump("0x1", 20, 300, { "cc/tile_memory": attrs(50), v8: attrs(24) }),
    // The trace ended before the GPU process gave this one's allocators.
    {
      name: "periodic_interval",
      ph: "v",
      pid: 20,
      tid: -1,
      ts: 2,
      id: "0x2",
      args: { dumps: { process_totals: { private_footprint_bytes: hex(999) } } },
    },
  ]

  it("reads the last global dump with allocators, merged by process, two levels deep", () => {
    const [gpu, renderer] = lastDumps(events)
    expect(gpu).toMatchObject({ pid: 10, kind: "gpu", privateFootprintMB: 150 })
    expect(gpu!.nodes["gpu/shared_images"]).toEqual({ size: 40, effective: 2 })
    expect(gpu!.nodes["gpu/gl"]).toEqual({ size: 8 })
    expect(gpu!.nodes["malloc"]).toEqual({ size: 5 })
    // Deeper nodes and ids are left out.
    expect(Object.keys(gpu!.nodes)).not.toContain("gpu/shared_images/client_0x6")
    expect(Object.keys(gpu!.nodes)).not.toContain("shared_memory/ABC")
    expect(renderer).toMatchObject({ pid: 20, kind: "renderer", privateFootprintMB: 300 })
    expect(renderer!.nodes["cc/tile_memory"]).toEqual({ size: 50 })
  })

  it("reads nothing from a trace without a dump of the GPU process", () => {
    expect(lastDumps([named(20, "Renderer"), ...dump("0x0", 20, 1, { v8: attrs(1) })])).toEqual([])
  })
})

describe("memoryMarkdown", () => {
  const gl = (mounted: number, atlases: GlReport["atlases"] = []): GlReport => ({
    mounted,
    inView: mounted,
    withContext: mounted,
    contextLost: 0,
    addons: mounted,
    lostEvents: 0,
    atlases,
    atlasTexturesMB: atlases.reduce((sum, one) => sum + one.pagesMB * one.contexts, 0),
  })
  const sample = (point: MemorySample["point"], mounted: number, gpu: number): MemorySample => ({
    point,
    terminals: mounted,
    gl: gl(
      mounted,
      mounted ? [{ pages: [{ width: 512, height: 512 }], contexts: mounted, pagesMB: 1 }] : [],
    ),
    dumps: 2,
    processes: [
      {
        pid: 1,
        kind: "gpu",
        name: "GPU Process",
        privateFootprintMB: gpu,
        nodes: { "gpu/shared_images": { size: gpu / 2, effective: gpu / 4 } },
      },
    ],
  })
  const run = (n: number, gpu: number): RunResult => ({
    scenario: "timing",
    variant: "production",
    run: n,
    agentPhases: [],
    attributed: true,
    phases: [],
    problems: [],
    memory: [sample("boot", 0, 100), sample("grid", 13, gpu)],
  })

  it("tables the samples by point, medians with their range, and the atlas textures", () => {
    const text = memoryMarkdown([run(1, 200), run(2, 300)])
    expect(text).toContain("### timing, production\n\n| | boot | grid | focus | switches |")
    expect(text).toContain("| Terminals mounted | 0 | 13 | – | – |")
    expect(text).toContain("| Atlas textures, pages times contexts (MB) | 0 | 13 | – | – |")
    expect(text).toContain(
      "| GPU process, private footprint (dump, MB) | 100 | 250 (200–300) | – | – |",
    )
    expect(text).toContain("| gpu dump `gpu/shared_images` (size) | 50 | 125 (100–150) | – | – |")
    expect(text).toContain("Last atlases seen (grid): 1 page (512×512) held by 13 contexts")
    // A number no sample gave has no row.
    expect(text).not.toContain("private bytes (Electron")
  })

  it("is empty where no run sampled memory", () => {
    const { memory: _, ...bare } = run(1, 1)
    expect(memoryMarkdown([bare])).toBe("")
  })
})
