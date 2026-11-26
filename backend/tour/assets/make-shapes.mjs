// Regenerates seed/models/shapes.bin: a unit box, sphere, cone and cylinder (each 1 wide,
// centred), with normals, which seed/models/placeholder.gltf's accessors point into. Run it as
// `node make-shapes.mjs` and keep its printed layout true to the accessors in the seed's
// models/README.md and placeholder.gltf. It lives beside the seed, not in it: the tour never writes it.
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
const shapes = []
const box = () => {
  const p = [],
    n = [],
    i = []
  const faces = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]
  for (const [x, y, z] of faces) {
    const u = x ? [0, 1, 0] : [1, 0, 0]
    const v = [y * u[2] - z * u[1], z * u[0] - x * u[2], x * u[1] - y * u[0]]
    const b = p.length / 3
    for (const [a, c] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      p.push(
        (x + a * u[0] + c * v[0]) / 2,
        (y + a * u[1] + c * v[1]) / 2,
        (z + a * u[2] + c * v[2]) / 2,
      )
      n.push(x, y, z)
    }
    i.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  return { p, n, i }
}
const sphere = (seg = 24, rings = 16) => {
  const p = [],
    n = [],
    i = []
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= seg; s++) {
      const t = (Math.PI * r) / rings,
        f = (2 * Math.PI * s) / seg
      const x = Math.sin(t) * Math.cos(f),
        y = Math.cos(t),
        z = Math.sin(t) * Math.sin(f)
      p.push(x / 2, y / 2, z / 2)
      n.push(x, y, z)
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s,
        b = a + seg + 1
      i.push(a, a + 1, b, b, a + 1, b + 1)
    }
  return { p, n, i }
}
// A cylinder whose top radius is `top` (0: a cone), 1 tall, base radius 0.5.
const round = (top, seg = 32) => {
  const p = [],
    n = [],
    i = []
  const slope = 0.5 - top
  for (let s = 0; s <= seg; s++) {
    const f = (2 * Math.PI * s) / seg,
      c = Math.cos(f),
      z = Math.sin(f)
    const len = Math.hypot(1, slope)
    p.push(c * 0.5, -0.5, z * 0.5)
    n.push(c / len, slope / len, z / len)
    p.push(c * top, 0.5, z * top)
    n.push(c / len, slope / len, z / len)
  }
  for (let s = 0; s < seg; s++) {
    const a = 2 * s
    i.push(a, a + 1, a + 2, a + 2, a + 1, a + 3)
  }
  for (const [y, r, ny] of [
    [-0.5, 0.5, -1],
    [0.5, top, 1],
  ]) {
    if (r === 0) continue
    const centre = p.length / 3
    p.push(0, y, 0)
    n.push(0, ny, 0)
    for (let s = 0; s <= seg; s++) {
      const f = (2 * Math.PI * s) / seg
      p.push(Math.cos(f) * r, y, Math.sin(f) * r)
      n.push(0, ny, 0)
    }
    for (let s = 0; s < seg; s++) {
      if (ny > 0) i.push(centre, centre + s + 2, centre + s + 1)
      else i.push(centre, centre + s + 1, centre + s + 2)
    }
  }
  return { p, n, i }
}
shapes.push(["box", box()], ["sphere", sphere()], ["cone", round(0)], ["cylinder", round(0.5)])
const chunks = [],
  views = [],
  accessors = []
let offset = 0
const add = (data, target, type, componentType, minmax) => {
  const buf = Buffer.from(data.buffer)
  const pad = (4 - (buf.length % 4)) % 4
  views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target })
  accessors.push({
    bufferView: views.length - 1,
    componentType,
    count: type === "SCALAR" ? data.length : data.length / 3,
    type,
    ...minmax,
  })
  chunks.push(buf, Buffer.alloc(pad))
  offset += buf.length + pad
}
for (const [, { p, n, i }] of shapes) {
  const P = new Float32Array(p)
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (let k = 0; k < P.length; k++) {
    min[k % 3] = Math.min(min[k % 3], P[k])
    max[k % 3] = Math.max(max[k % 3], P[k])
  }
  add(P, 34962, "VEC3", 5126, { min, max })
  add(new Float32Array(n), 34962, "VEC3", 5126, {})
  add(new Uint16Array(i), 34963, "SCALAR", 5123, {})
}
writeFileSync(
  fileURLToPath(new URL("seed/models/shapes.bin", import.meta.url)),
  Buffer.concat(chunks),
)
console.log("bytes", offset)
shapes.forEach(([name], k) =>
  console.log(`${name}: POSITION ${k * 3}, NORMAL ${k * 3 + 1}, indices ${k * 3 + 2}`),
)
