import type {
  ChangeFileDiff,
  ChangedFile,
  ChangesContent,
  DiffHunk,
  ItemContent,
} from "@novadeck/core/items"
import type { PreviewHunk } from "@novadeck/core/works"

// What the tour's agents show and change, as the runner's tour would have them: the seed
// project's files by name, the game's page, the hero's 3D model (a start shape and one sculpted
// for each world), and the builder's changes. Small and made here, not kept as files: the demo
// ships in the website's bundle, and this is loaded only as a story plays.

// The tour repo's files, as its Files panel lists them (the runner's seed, and the libraries it
// keeps out of git under vendor/).
export const tourEntries: readonly string[] = [
  ".gitattributes",
  ".gitignore",
  "README.md",
  "dev.mjs",
  "dev.py",
  "index.html",
  "models/README.md",
  "models/placeholder.gltf",
  "models/shapes.bin",
  "src/main.js",
  "src/models.js",
  "src/style.css",
  "vendor/",
]

export const tourIgnored: readonly string[] = ["vendor/"]

export const modelFile = "models/hero.gltf"
export const gameFile = "src/main.js"

// The branches the agents' worktrees are on.
export const branches = {
  modeller: "models",
  builder: "build",
} as const

// The address the game's page is at.
export const pageUrl = "http://127.0.0.1:5173/"
export const serverCommand = "node dev.mjs 5173"

// ---- The hero ----

export type Hero = {
  // What the person picked on the sheet: "Sci-fi" and "Strategy", or their own words.
  readonly world: string
  readonly kind: string
  // Which of the models it is sculpted as.
  readonly shape: "rocket" | "robot" | "cat"
  readonly title: string
  readonly pickup: string
  readonly background: string
  readonly accent: string
}

const looks: Readonly<Record<Hero["shape"], Pick<Hero, "pickup" | "background" | "accent">>> = {
  rocket: { pickup: "⭐", background: "#0d0b1a", accent: "#ff4fd8" },
  robot: { pickup: "🔩", background: "#08121f", accent: "#22e5ee" },
  cat: { pickup: "🐟", background: "#120a24", accent: "#c6f432" },
}

// The game a sheet's answers name: the world picks the hero's shape (Sci-fi a rocket, Modern a
// robot, anything else, Fantasy among it, a cat), and both name the game.
export const heroOf = (world: string, kind: string): Hero => {
  const shape = /sci|space|rocket/i.test(world)
    ? "rocket"
    : /modern|city|robot/i.test(world)
      ? "robot"
      : "cat"
  return { world, kind, shape, title: `${world} ${kind}`, ...looks[shape] }
}

// ---- The model ----

type Shape = "cube" | "octa"
type Part = {
  readonly shape: Shape
  readonly at: readonly [number, number, number]
  readonly size: readonly [number, number, number]
  readonly color: string
}

const start: readonly Part[] = [
  { shape: "octa", at: [0, 0.55, 0], size: [0.9, 0.9, 0.9], color: "#9a9aa6" },
  { shape: "cube", at: [0, -0.4, 0], size: [0.8, 0.5, 0.8], color: "#6b6b78" },
]

const sculpted: Readonly<Record<Hero["shape"], readonly Part[]>> = {
  rocket: [
    { shape: "cube", at: [0, 0, 0], size: [0.5, 1.3, 0.5], color: "#e8ecf4" },
    { shape: "octa", at: [0, 0.95, 0], size: [0.5, 0.8, 0.5], color: "#ff5a3c" },
    { shape: "cube", at: [-0.38, -0.5, 0], size: [0.3, 0.5, 0.12], color: "#ff5a3c" },
    { shape: "cube", at: [0.38, -0.5, 0], size: [0.3, 0.5, 0.12], color: "#ff5a3c" },
    { shape: "octa", at: [0, -0.9, 0], size: [0.3, 0.45, 0.3], color: "#ffb43c" },
  ],
  robot: [
    { shape: "cube", at: [0, -0.2, 0], size: [0.8, 0.9, 0.5], color: "#8fa4b3" },
    { shape: "cube", at: [0, 0.5, 0], size: [0.55, 0.45, 0.45], color: "#b9c8d3" },
    { shape: "cube", at: [-0.14, 0.55, 0.23], size: [0.1, 0.1, 0.05], color: "#3fd0c9" },
    { shape: "cube", at: [0.14, 0.55, 0.23], size: [0.1, 0.1, 0.05], color: "#3fd0c9" },
    { shape: "octa", at: [0, 0.9, 0], size: [0.14, 0.3, 0.14], color: "#ff5a3c" },
    { shape: "cube", at: [-0.55, -0.2, 0], size: [0.2, 0.7, 0.2], color: "#6c7f8d" },
    { shape: "cube", at: [0.55, -0.2, 0], size: [0.2, 0.7, 0.2], color: "#6c7f8d" },
  ],
  cat: [
    { shape: "cube", at: [0, -0.25, 0], size: [0.9, 0.6, 0.5], color: "#ff9d3c" },
    { shape: "cube", at: [0, 0.35, 0.1], size: [0.6, 0.5, 0.5], color: "#ffb45e" },
    { shape: "octa", at: [-0.2, 0.75, 0.1], size: [0.2, 0.35, 0.12], color: "#ff9d3c" },
    { shape: "octa", at: [0.2, 0.75, 0.1], size: [0.2, 0.35, 0.12], color: "#ff9d3c" },
    { shape: "cube", at: [0.55, 0.05, 0], size: [0.12, 0.7, 0.12], color: "#ff9d3c" },
  ],
}

// A unit cube and an octahedron: positions and indices only, in the one buffer the glTF carries
// as a data address, so the model is a file of its own and nothing else. With no normals, a
// viewer shades them flat, as the shapes are meant to look.
const buffer = (): Uint8Array<ArrayBuffer> => {
  const cube = [-0.5, 0.5].flatMap((z) =>
    [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].flatMap((x) => [x, y, z])),
  )
  // Each face's four corners, counter-clockwise from outside, as two triangles.
  const faces = [
    [1, 3, 7, 5],
    [0, 4, 6, 2],
    [2, 6, 7, 3],
    [0, 1, 5, 4],
    [4, 5, 7, 6],
    [0, 2, 3, 1],
  ]
  const cubeIndices = faces.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!])
  const octa = [0.5, 0, 0, -0.5, 0, 0, 0, 0.5, 0, 0, -0.5, 0, 0, 0, 0.5, 0, 0, -0.5]
  // One triangle to each octant, wound outward: flipped where the signs multiply to a negative.
  const octaIndices = [1, -1].flatMap((x) =>
    [1, -1].flatMap((y) =>
      [1, -1].flatMap((z) => {
        const corners = [x > 0 ? 0 : 1, y > 0 ? 2 : 3, z > 0 ? 4 : 5] as const
        return x * y * z > 0
          ? [corners[0], corners[1], corners[2]]
          : [corners[0], corners[2], corners[1]]
      }),
    ),
  )
  const parts = [
    new Float32Array(cube),
    new Uint16Array(cubeIndices),
    new Float32Array(octa),
    new Uint16Array(octaIndices),
  ]
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    bytes.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at)
    at += part.byteLength
  }
  return bytes
}

const base64 = (bytes: Uint8Array<ArrayBuffer>): string => {
  let text = ""
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

const linear = (hex: string): number[] =>
  [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 100) / 100)

// The glTF of parts: two meshes' accessors, shared, and a node and material for each part.
const gltf = (parts: readonly Part[]): Uint8Array<ArrayBuffer> => {
  const data = buffer()
  const views = [96, 72, 72, 48]
  let offset = 0
  const bufferViews = views.map((byteLength, index) => {
    const view = {
      buffer: 0,
      byteOffset: offset,
      byteLength,
      target: index % 2 === 1 ? 34963 : 34962,
    }
    offset += byteLength
    return view
  })
  const half = { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }
  const accessors = [
    { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", ...half },
    { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
    { bufferView: 2, componentType: 5126, count: 6, type: "VEC3", ...half },
    { bufferView: 3, componentType: 5123, count: 24, type: "SCALAR" },
  ]
  // A mesh for each shape in each colour, which the nodes share.
  const kinds = [...new Set(parts.map((part) => `${part.shape} ${part.color}`))]
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: parts.map((_, index) => index) }],
    nodes: parts.map((part) => ({
      mesh: kinds.indexOf(`${part.shape} ${part.color}`),
      translation: part.at,
      scale: part.size,
    })),
    meshes: kinds.map((kind, index) => {
      const first = kind.startsWith("cube") ? 0 : 2
      return {
        primitives: [{ attributes: { POSITION: first }, indices: first + 1, material: index }],
      }
    }),
    materials: kinds.map((kind) => ({
      pbrMetallicRoughness: {
        baseColorFactor: [...linear(kind.split(" ")[1]!), 1],
        metallicFactor: 0,
        roughnessFactor: 0.8,
      },
    })),
    accessors,
    bufferViews,
    buffers: [
      {
        byteLength: data.length,
        uri: `data:application/octet-stream;base64,${base64(data)}`,
      },
    ],
  }
  return new TextEncoder().encode(JSON.stringify(json))
}

export type Model = { readonly bytes: Uint8Array<ArrayBuffer>; readonly content: ItemContent }

// A model as the seed's placeholder has it (a ball and a box), or sculpted as `hero` is, as of
// `stamp`.
export const modelOf = (hero: Hero | undefined, stamp: string): Model => {
  const bytes = gltf(hero ? sculpted[hero.shape] : start)
  return {
    bytes,
    content: {
      state: "ready",
      stamp,
      content: { kind: "model", format: "gltf", size: bytes.length, files: [], refused: [] },
    },
  }
}

// ---- The page ----

const svgUri = (svg: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

// The game's page as its dev server serves it: the seed's plain game, or the team's, shown as a
// snapshot because the demo's pane can't load a page.
export const pageContent = (hero: Hero | undefined, shown: number): ItemContent => {
  const background = hero?.background ?? "#2b2b33"
  const accent = hero?.accent ?? "#9a9aa6"
  const lift = hero ? 0.2 : 0.12
  const city = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((i) => {
      const top = 380 + ((i * 97) % 5) * 40
      return `<rect x="${i * 210 - 30}" y="${top}" width="190" height="${900 - top}" fill="${accent}" opacity="${lift}"/><rect x="${i * 210 + 20}" y="${top + 30}" width="10" height="14" fill="${accent}" opacity="${hero ? 0.9 : 0.35}"/><rect x="${i * 210 + 90}" y="${top + 80}" width="10" height="14" fill="${accent}" opacity="${hero ? 0.9 : 0.35}"/>`
    })
    .join("")
  const body = hero
    ? `${city}<polygon points="800,380 880,560 720,560" fill="${accent}"/>
<text x="800" y="300" font-size="40" text-anchor="middle">${hero.pickup}</text>`
    : `${city}<circle cx="800" cy="440" r="70" fill="${accent}"/><rect x="740" y="520" width="120" height="70" fill="#6b6b78"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="${background}"/>
<g font-family="ui-monospace, Menlo, Consolas, monospace" fill="${accent}">${body}
<text x="800" y="150" font-size="64" font-weight="700" text-anchor="middle">${(hero?.title ?? "Untitled Game").toUpperCase()}</text>
<text x="60" y="860" font-size="32">SCORE 0</text></g></svg>`
  return {
    state: "ready",
    stamp: String(shown),
    content: { kind: "page", url: pageUrl, shown, live: false, snapshot: svgUri(svg) },
  }
}

// ---- The seed's file the story changes ----

export const gameMain = [
  "// The game starts here: it draws the city and moves the hero each frame.",
  'import { models } from "./models.js"',
  "",
  'const title = "Untitled Game"',
  "const speed = 2",
  "",
  "export const start = (canvas) => {",
  "  canvas.title = title",
  '  models.load("models/placeholder.gltf", speed)',
  "}",
]

const gameBuilt = (hero: Hero): string[] => [
  ...gameMain.slice(0, 3),
  `const title = "${hero.title}"`,
  "const speed = 4",
  "",
  "export const start = (canvas) => {",
  "  canvas.title = title",
  '  models.load("models/hero.gltf", speed)',
  "}",
]

export const mainOf = (path: string): string[] | undefined =>
  path === gameFile ? gameMain : undefined

// What a work does to a file in the merged preview: the lines it replaces (`at` from 1).
export const hunkOf = (path: string, hero: Hero | undefined): PreviewHunk | undefined =>
  path === gameFile && hero
    ? { at: 4, removed: gameMain.length - 3, lines: gameBuilt(hero).slice(3), applies: true }
    : undefined

// ---- The builder's changes ----

// A diff of the lines `from` replaced by `to`, with three lines around, as git writes one.
const diffOf = (before: readonly string[], after: readonly string[], at: number): DiffHunk => {
  let first = 0
  while (before[first] === after[first]) first += 1
  let last = 0
  while (
    last < before.length - first &&
    last < after.length - first &&
    before[before.length - 1 - last] === after[after.length - 1 - last]
  )
    last += 1
  const from = Math.max(0, first - at)
  const removedTo = before.length - last
  const addedTo = after.length - last
  const tail = Math.min(at, last)
  const lines = [
    ...before.slice(from, first).map((text) => ({ kind: "context" as const, text })),
    ...before.slice(first, removedTo).map((text) => ({ kind: "remove" as const, text })),
    ...after.slice(first, addedTo).map((text) => ({ kind: "add" as const, text })),
    ...before
      .slice(removedTo, removedTo + tail)
      .map((text) => ({ kind: "context" as const, text })),
  ]
  return {
    oldStart: from + 1,
    oldCount: removedTo + tail - from,
    newStart: from + 1,
    newCount: addedTo + tail - from,
    lines,
  }
}

const changed = (path: string, added: number, removed: number): ChangedFile => ({
  path,
  oldPath: null,
  status: "modified",
  added,
  removed,
  reindented: 0,
  binary: false,
  secret: false,
})

// The builder's change against main: src/main.js, its work not committed yet, as its `changes`
// item shows it.
export const builderChanges = (root: string): ChangesContent => {
  const files = [changed(gameFile, 3, 3)]
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  return {
    kind: "changes",
    root,
    base: "main",
    layers: [
      {
        id: "uncommitted",
        kind: "uncommitted",
        subject: "Work not committed yet",
        time: null,
        added,
        removed,
        files,
        truncated: false,
      },
    ],
    files,
    read: [],
    truncated: false,
  }
}

export const builderDiffs = (hero: Hero): Readonly<Record<string, ChangeFileDiff>> => {
  const after = gameBuilt(hero)
  return {
    [gameFile]: {
      run: {
        layers: ["uncommitted"],
        file: changed(gameFile, 3, 3),
        big: false,
        badName: false,
        hunks: [diffOf(gameMain, after, 3)],
        before: gameMain.join("\n") + "\n",
        after: after.join("\n") + "\n",
      },
    },
  }
}
