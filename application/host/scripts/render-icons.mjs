// Renders resources/icon.svg into the PNGs electron-builder packs: resources/icon.png
// (1024 px, converted for macOS and Windows) and resources/icons/NxN.png for Linux.
// Run with `node scripts/render-icons.mjs` after changing the SVG.
/* eslint-disable no-await-in-loop -- One page renders each size in turn. */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

const resources = fileURLToPath(new URL("../resources/", import.meta.url))
const svg = await readFile(`${resources}icon.svg`, "utf8")
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

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
    await image.screenshot({ path: `${resources}icons/${size}x${size}.png`, omitBackground: true })
    if (size === 1024)
      await image.screenshot({ path: `${resources}icon.png`, omitBackground: true })
  }
} finally {
  await browser.close()
}
