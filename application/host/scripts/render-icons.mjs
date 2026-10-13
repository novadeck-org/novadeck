// Renders resources/icon.svg into the images electron-builder packs: resources/icon.png
// (1024 px, converted for macOS), resources/icons/NxN.png for Linux, and resources/icon.ico
// for Windows.
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
const images = []

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
    if (icoSizes.has(size)) images.push({ size, png })
    if (size === 1024)
      await image.screenshot({ path: `${resources}icon.png`, omitBackground: true })
  }
  await writeFile(`${resources}icon.ico`, ico(images))
} finally {
  await browser.close()
}
