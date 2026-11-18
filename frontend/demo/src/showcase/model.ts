// The 3D models the demo's agents show, made here rather than kept as files: an L-bracket as
// a CAD loop writes it (STL, in millimetres, Z up), longer once it's rewritten; an arm as a
// glTF with its buffer beside it and an animation that swings it; a crate as an OBJ with its
// material library; and a scan as a PLY of coloured points.

type Box = readonly [x: number, y: number, z: number, width: number, depth: number, height: number]

// Two triangles of a face, its corners in order.
const quad = (a: number[], b: number[], e: number[], f: number[]) => [
  [a, b, e],
  [a, e, f],
]

// A box's twelve triangles, each three corners, wound outward.
const triangles = ([x, y, z, w, d, h]: Box): number[][][] => {
  const c = (i: number, j: number, k: number) => [x + i * w, y + j * d, z + k * h]

  return [
    ...quad(c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)),
    ...quad(c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)),
    ...quad(c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)),
    ...quad(c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)),
    ...quad(c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)),
    ...quad(c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)),
  ]
}

// Boxes as a binary STL: its header, its count, and each triangle's normal and corners.
const stl = (boxes: readonly Box[]): Uint8Array<ArrayBuffer> => {
  const all = boxes.flatMap(triangles)
  const bytes = new ArrayBuffer(84 + all.length * 50)
  const view = new DataView(bytes)
  new TextEncoder().encodeInto("Novadeck demo bracket", new Uint8Array(bytes, 0, 80))
  view.setUint32(80, all.length, true)
  all.forEach((corners, at) => {
    const [a, b, e] = corners as [number[], number[], number[]]
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
    const v = [e[0]! - a[0]!, e[1]! - a[1]!, e[2]! - a[2]!]
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ]
    const length = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
    const values = [...n.map((each) => each / length), ...a, ...b, ...e]
    values.forEach((value, index) => view.setFloat32(84 + at * 50 + index * 4, value, true))
  })
  return new Uint8Array(bytes)
}

/** The bracket, `length` millimetres long: a base, an upright and two gussets. */
export const bracket = (length = 60): Uint8Array<ArrayBuffer> =>
  stl([
    [0, 0, 0, length, 40, 5],
    [0, 0, 5, length, 5, 35],
    [4, 5, 5, 4, 14, 14],
    [length - 8, 5, 5, 4, 14, 14],
  ])

// A box as indexed positions and normals, for a glTF's mesh.
const boxMesh = (w: number, d: number, h: number) => {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (const corners of triangles([-w / 2, 0, -d / 2, w, h, d])) {
    const [a, b, e] = corners as [number[], number[], number[]]
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
    const v = [e[0]! - a[0]!, e[1]! - a[1]!, e[2]! - a[2]!]
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ]
    const length = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
    for (const corner of corners) {
      indices.push(positions.length / 3)
      positions.push(...corner)
      normals.push(...n.map((each) => each / length))
    }
  }
  return { positions, normals, indices }
}

// A mesh's least and most corner, as a glTF's accessor gives them.
const bounds = (positions: number[]) => {
  const axis = (index: number) => positions.filter((_, at) => at % 3 === index)
  return {
    min: [0, 1, 2].map((index) => Math.min(...axis(index))),
    max: [0, 1, 2].map((index) => Math.max(...axis(index))),
  }
}

/**
 * The arm, as a glTF and the buffer it names (`arm.bin`): a base, and a boom on a joint that
 * an animation swings back and forth over two seconds. In metres, as glTF is.
 */
export const arm = (): {
  readonly gltf: Uint8Array<ArrayBuffer>
  readonly bin: Uint8Array<ArrayBuffer>
} => {
  const base = boxMesh(0.12, 0.12, 0.04)
  const boom = boxMesh(0.03, 0.03, 0.2)
  const times = [0, 1, 2]
  const turns = [0, 0.38, 0]
  const rotations = turns.flatMap((angle) => [0, 0, Math.sin(angle), Math.cos(angle)])
  const chunks: { data: Float32Array | Uint16Array; target?: number }[] = [
    { data: new Float32Array(base.positions), target: 34962 },
    { data: new Float32Array(base.normals), target: 34962 },
    { data: new Uint16Array(base.indices), target: 34963 },
    { data: new Float32Array(boom.positions), target: 34962 },
    { data: new Float32Array(boom.normals), target: 34962 },
    { data: new Uint16Array(boom.indices), target: 34963 },
    { data: new Float32Array(times) },
    { data: new Float32Array(rotations) },
  ]
  const views: Record<string, number>[] = []
  let length = 0
  for (const { data, target } of chunks) {
    views.push({
      buffer: 0,
      byteOffset: length,
      byteLength: data.byteLength,
      ...(target && { target }),
    })
    length += Math.ceil(data.byteLength / 4) * 4
  }
  const bin = new Uint8Array(length)
  chunks.forEach(({ data }, at) => bin.set(new Uint8Array(data.buffer), views[at]!.byteOffset!))

  const json = {
    asset: { version: "2.0", generator: "Novadeck demo" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Base", mesh: 0, children: [1] },
      { name: "Joint", translation: [0, 0.04, 0], children: [2] },
      { name: "Boom", mesh: 1 },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] },
      { primitives: [{ attributes: { POSITION: 3, NORMAL: 4 }, indices: 5, material: 1 }] },
    ],
    materials: [
      {
        name: "Steel",
        pbrMetallicRoughness: {
          baseColorFactor: [0.55, 0.58, 0.62, 1],
          metallicFactor: 0.6,
          roughnessFactor: 0.4,
        },
      },
      {
        name: "Orange",
        pbrMetallicRoughness: {
          baseColorFactor: [0.95, 0.45, 0.1, 1],
          metallicFactor: 0.1,
          roughnessFactor: 0.6,
        },
      },
    ],
    buffers: [{ uri: "arm.bin", byteLength: length }],
    bufferViews: views,
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: base.positions.length / 3,
        type: "VEC3",
        ...bounds(base.positions),
      },
      { bufferView: 1, componentType: 5126, count: base.normals.length / 3, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: base.indices.length, type: "SCALAR" },
      {
        bufferView: 3,
        componentType: 5126,
        count: boom.positions.length / 3,
        type: "VEC3",
        ...bounds(boom.positions),
      },
      { bufferView: 4, componentType: 5126, count: boom.normals.length / 3, type: "VEC3" },
      { bufferView: 5, componentType: 5123, count: boom.indices.length, type: "SCALAR" },
      {
        bufferView: 6,
        componentType: 5126,
        count: times.length,
        type: "SCALAR",
        min: [0],
        max: [2],
      },
      { bufferView: 7, componentType: 5126, count: times.length, type: "VEC4" },
    ],
    animations: [
      {
        name: "Swing",
        samplers: [{ input: 6, output: 7, interpolation: "LINEAR" }],
        channels: [{ sampler: 0, target: { node: 1, path: "rotation" } }],
      },
    ],
  }
  return { gltf: new TextEncoder().encode(JSON.stringify(json)), bin }
}

/** A glTF as `arm` writes it, but with `more` in its JSON (an address of its own, say). */
export const armWith = (more: Record<string, unknown>): Uint8Array<ArrayBuffer> => {
  const json = JSON.parse(new TextDecoder().decode(arm().gltf)) as Record<string, unknown>
  return new TextEncoder().encode(JSON.stringify({ ...json, ...more }))
}

/** The crate as an OBJ, and its material library (`crate.mtl`), which colours it. */
export const crate = (): {
  readonly obj: Uint8Array<ArrayBuffer>
  readonly mtl: Uint8Array<ArrayBuffer>
} => {
  const lines = ["# Novadeck demo crate", "mtllib crate.mtl"]
  let vertices = 0
  const add = (box: Box, material: string) => {
    lines.push(`usemtl ${material}`)
    for (const corners of triangles(box)) {
      for (const corner of corners) lines.push(`v ${corner.join(" ")}`)
      lines.push(`f ${vertices + 1} ${vertices + 2} ${vertices + 3}`)
      vertices += 3
    }
  }
  add([0, 0, 0, 1, 1, 1], "wood")
  add([-0.05, 0.45, -0.05, 1.1, 0.1, 1.1], "band")
  const mtl = ["newmtl wood", "Kd 0.72 0.52 0.3", "newmtl band", "Kd 0.25 0.27 0.3", ""].join("\n")
  return {
    obj: new TextEncoder().encode(`${lines.join("\n")}\n`),
    mtl: new TextEncoder().encode(mtl),
  }
}

/** A scan of a dome, as a PLY of coloured points. */
export const scan = (): Uint8Array<ArrayBuffer> => {
  const points: string[] = []
  for (let ring = 0; ring <= 24; ring += 1)
    for (let step = 0; step < 72; step += 1) {
      const up = (ring / 24) * (Math.PI / 2)
      const round = (step / 72) * Math.PI * 2
      const x = Math.cos(up) * Math.cos(round) * 50
      const y = Math.cos(up) * Math.sin(round) * 50
      const z = Math.sin(up) * 50
      const shade = Math.round(90 + (ring / 24) * 150)
      points.push(
        `${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)} ${shade} ${Math.round(shade * 0.8)} 200`,
      )
    }
  return new TextEncoder().encode(
    [
      "ply",
      "format ascii 1.0",
      `element vertex ${points.length}`,
      "property float x",
      "property float y",
      "property float z",
      "property uchar red",
      "property uchar green",
      "property uchar blue",
      "end_header",
      ...points,
      "",
    ].join("\n"),
  )
}

/** Bytes that aren't a model of any format. */
export const notAModel = new TextEncoder().encode(
  "solid nothing\nThis was meant to be a bracket.\n",
)
