import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { brotliDecompressSync } from "node:zlib"

import { loadBuffer } from "font-ligatures"

// What the ligature table is checked against: the font the app ships, read as a shaper in
// Node. Dev and test only; the browser never loads any of it.

// The WOFF2 spec's table of known tags, which a table directory entry names by index.
const knownTags = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf",
  "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT",
  "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT",
  "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar",
  "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd",
  "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
] // prettier-ignore

// The tables of a WOFF2 that its compression leaves as they were (all but glyf and loca,
// which are transformed): the layout tables a shaper needs.
const woff2Tables = (file: Buffer): Map<string, Buffer> => {
  if (file.toString("latin1", 0, 4) !== "wOF2") throw new Error("Not a WOFF2 file")
  const count = file.readUInt16BE(12)
  const compressed = file.readUInt32BE(20)
  let at = 48
  const base128 = (): number => {
    let value = 0
    for (let i = 0; i < 5; i++) {
      const byte = file[at++] ?? 0
      value = value * 128 + (byte & 0x7f)
      if (!(byte & 0x80)) return value
    }
    throw new Error("Bad UIntBase128")
  }
  const entries: { name: string; length: number; transformed: boolean }[] = []
  for (let i = 0; i < count; i++) {
    const flags = file[at++] ?? 0
    const index = flags & 63
    const name = index === 63 ? file.toString("latin1", at, (at += 4)) : knownTags[index]
    const version = flags >> 6
    const original = base128()
    const transformed = name === "glyf" || name === "loca" ? version === 0 : version !== 0
    entries.push({ name: name ?? "", length: transformed ? base128() : original, transformed })
  }
  const data = brotliDecompressSync(file.subarray(at, at + compressed))
  const tables = new Map<string, Buffer>()
  let from = 0
  for (const entry of entries) {
    if (!entry.transformed) tables.set(entry.name, data.subarray(from, from + entry.length))
    from += entry.length
  }
  return tables
}

// A font file the shaper's parser takes: the layout tables, the outline tables empty.
const sfnt = (tables: Map<string, Buffer>): Buffer => {
  const need = (name: string): Buffer => {
    const table = tables.get(name)
    if (!table) throw new Error(`The font has no ${name} table`)
    return table
  }
  const maxp = need("maxp")
  const glyphs = maxp.readUInt16BE(4)
  const head = Buffer.from(need("head"))
  head.writeInt16BE(1, 50) // long loca offsets
  const hhea = Buffer.from(need("hhea"))
  hhea.writeUInt16BE(0, 34) // no metrics to read
  const parts = new Map<string, Buffer>([
    ["GSUB", need("GSUB")],
    ["cmap", need("cmap")],
    ["glyf", Buffer.alloc(4)],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", Buffer.alloc(4 + 2 * glyphs)],
    ["loca", Buffer.alloc(4 * (glyphs + 1))],
    ["maxp", maxp],
    ["name", Buffer.alloc(6)],
    ["OS/2", Buffer.alloc(78)],
    ["post", Buffer.alloc(32)],
  ])
  const tags = [...parts.keys()].toSorted()
  const header = Buffer.alloc(12 + 16 * tags.length)
  header.writeUInt32BE(0x00010000, 0)
  header.writeUInt16BE(tags.length, 4)
  const bodies: Buffer[] = []
  let offset = header.length
  tags.forEach((tag, i) => {
    const body = parts.get(tag) ?? Buffer.alloc(0)
    header.write(tag, 12 + 16 * i, "latin1")
    header.writeUInt32BE(offset, 12 + 16 * i + 8)
    header.writeUInt32BE(body.length, 12 + 16 * i + 12)
    const padding = Buffer.alloc((4 - (body.length % 4)) % 4)
    bodies.push(body, padding)
    offset += body.length + padding.length
  })
  return Buffer.concat([header, ...bodies])
}

// The bundled JetBrains Mono's variable font, the Latin subset the app loads.
export const bundledFont = (): string =>
  createRequire(import.meta.url).resolve(
    "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  )

// What the font does to `text`: the ranges it draws as ligatures, as its own substitution rules
// say, and the glyph it draws at each cell (the id a rule swapped in; a plain glyph where none).
export type Shaper = (text: string) => [number, number][]
export type Font = { readonly shape: Shaper; readonly glyphs: (text: string) => number[] }

export const loadFont = async (path = bundledFont()): Promise<Font> => {
  const file = sfnt(woff2Tables(readFileSync(path)))
  const font = await loadBuffer(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
    { cacheSize: 0 },
  )
  return {
    shape: (text) => font.findLigatureRanges(text).map(([from, to]) => [from, to]),
    glyphs: (text) => [...font.findLigatures(text).outputGlyphs],
  }
}

export const loadShaper = async (path?: string): Promise<Shaper> => (await loadFont(path)).shape
