// Renders resources/icon.svg into the images electron-builder packs: resources/icon.png
// (1024 px), resources/icons/NxN.png for Linux, resources/icon.ico for Windows and
// resources/icon.icns for macOS.
// Run with `node scripts/render-icons.mjs` after changing the SVG.
/* eslint-disable no-await-in-loop -- One page renders each size in turn. */
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

const resources = fileURLToPath(new URL("../resources/", import.meta.url))
const svg = await readFile(`${resources}icon.svg`, "utf8")
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
// Windows gets its own .ico: given the 1024 px PNG, builder would scale it down itself and
// the shell would never see the hand-placed 16, 24 and 32 px art. The entries are the
// rendered PNGs, which Vista and later read as they are; builder wants the 256 px one.
const icoSizes = new Set([16, 24, 32, 48, 64, 128, 256])

// An ICO is a 6-byte header, one 16-byte entry per image, then the images themselves.
const ico = (images) => {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index
    header.writeUInt8(size === 256 ? 0 : size, entry) // width, 0 meaning 256
    header.writeUInt8(size === 256 ? 0 : size, entry + 1) // height
    header.writeUInt16LE(1, entry + 4) // color planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(({ png }) => png)])
}

// macOS gets its own .icns for the same reason: Finder and Spotlight draw the 16 and 32 pt
// slots, which would otherwise be scaled from 1024 px. Each slot takes the rendered PNG of
// its pixel size, so a Retina 16 pt slot (32 px) gets the hand-placed 32 px art.
const icnsTypes = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024], // 512 pt at 2x
  ["ic11", 32], // 16 pt at 2x
  ["ic12", 64], // 32 pt at 2x
  ["ic13", 256], // 128 pt at 2x
  ["ic14", 512], // 256 pt at 2x
]

// An ICNS is "icns" and its whole length, then per image its type, its length with this
// 8-byte header, and the PNG, all big-endian.
const icns = (pngs) => {
  const chunks = icnsTypes.map(([type, size]) => {
    const png = pngs.get(size)
    const header = Buffer.alloc(8)
    header.write(type, 0, "latin1")
    header.writeUInt32BE(8 + png.length, 4)
    return Buffer.concat([header, png])
  })
  const header = Buffer.alloc(8)
  header.write("icns", 0, "latin1")
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
  return Buffer.concat([header, ...chunks])
}
const pngs = new Map()

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg.replace(
        /width="1024" height="1024"/,
        `width="${size}" height="${size}"`,
      )}</body></html>`,
    )
    const image = page.locator("svg")
    const png = await image.screenshot({
      path: `${resources}icons/${size}x${size}.png`,
      omitBackground: true,
    })
    pngs.set(size, png)
    if (size === 1024)
      await image.screenshot({ path: `${resources}icon.png`, omitBackground: true })
  }
  await writeFile(
    `${resources}icon.ico`,
    ico(sizes.filter((size) => icoSizes.has(size)).map((size) => ({ size, png: pngs.get(size) }))),
  )
  await writeFile(`${resources}icon.icns`, icns(pngs))
} finally {
  await browser.close()
}
