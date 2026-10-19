import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join, normalize, resolve, sep } from "node:path"

import { chromium, type Browser, type Page } from "playwright"

// `pnpm poster:try [dir]`: writes `poster-<scheme>-<width>.webp` into a built visitor demo
// (`dist` unless a directory is given), for light and dark and for 1280 and 2560
// pixels wide: screenshots of the demo held at its first frames (`?embed&still`: Claude Code just begun reading),
// where the live app picks up. Each width is captured at its own pixel
// density rather than scaled down, so the text is drawn for that size. The website shows
// them while the live demo loads, so the Try workflow makes them from the very build it
// deploys. Needs the build and Playwright's Chromium (`playwright install chromium`).

// Opens the demo held at its first frames, and waits until it has booted and Claude Code's
// terminal has drawn its opening.
const boot = async (page: Page, origin: string): Promise<void> => {
  await page.goto(`${origin}/?embed&still`)
  // Booted means the splash came and has left the page, and the header's view choice shows.
  const splash = page.locator(".boot-splash")
  await splash.waitFor({ state: "attached", timeout: bootTimeoutMs })
  await splash.waitFor({ state: "detached", timeout: bootTimeoutMs })
  await page
    .getByRole("radiogroup", { name: "Workspace layout" })
    .first()
    .waitFor({ state: "visible", timeout: bootTimeoutMs })
  // Claude Code's terminal has drawn its opening: its screen reader's tree holds the text the
  // terminal wrote, and the DOM renderer's rows the same, whichever draws.
  await page
    .getByText("I’ll read the checkout layout")
    .first()
    .waitFor({ state: "visible", timeout: bootTimeoutMs })
}

// The hero's resting shape: twice as wide as tall, with the app laid out 1280 px wide.
const viewport = { width: 1280, height: 640 }
// A phone is served the smaller poster, a dense screen the larger.
const scales = [1, 2] as const
// Keeps the interface's text crisp at around 60 KB for 1280 wide and 150 KB for 2560.
const quality = 0.9
const bootTimeoutMs = 30_000
// How long the demo may take, held still, from the address to Claude Code's terminal drawn,
// on a CPU four times slower than the machine's: the website gives up waiting at 15 s.
export const bootBudgetMs = 8000
const throttle = 4
const samples = 3

const schemes = ["light", "dark"] as const

const types: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".mjs": "text/javascript",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
}

// A static file server over a directory, which is all the build needs. Returns its
// origin and a stop function.
const serve = async (
  root: string,
): Promise<{ readonly origin: string; readonly stop: () => Promise<void> }> => {
  const server = createServer((request, response) => {
    void (async () => {
      let path: string
      try {
        path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
      } catch {
        response.writeHead(400).end()
        return
      }
      const file = normalize(join(root, path.endsWith("/") ? `${path}index.html` : path))
      if (file !== root && !file.startsWith(root + sep)) {
        response.writeHead(403).end()
        return
      }
      try {
        const body = await readFile(file)
        response.writeHead(200, {
          "content-type": types[extname(file)] ?? "application/octet-stream",
        })
        response.end(body)
      } catch {
        response.writeHead(404).end()
      }
    })()
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise((done) => server.close(() => done())),
  }
}

// Waits in the page for fonts and two drawn frames, so layout has settled.
const settle = async (): Promise<void> => {
  await document.fonts.ready
  await new Promise((next) => requestAnimationFrame(next))
  await new Promise((next) => requestAnimationFrame(next))
}

// Re-encodes a PNG, given as base64, as WebP in the page, and returns it as base64.
const encode = async ({
  png,
  quality: level,
}: {
  png: string
  quality: number
}): Promise<string> => {
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/webp", level))
  if (!blob || blob.type !== "image/webp") throw new Error("The browser can't encode WebP")
  const out = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let at = 0; at < out.length; at += 0x8000)
    binary += String.fromCharCode(...out.subarray(at, at + 0x8000))
  return btoa(binary)
}

const capture = async (
  browser: Browser,
  origin: string,
  root: string,
  colorScheme: (typeof schemes)[number],
  scale: (typeof scales)[number],
): Promise<void> => {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    colorScheme,
  })
  const page = await context.newPage()
  // `still` holds the desk at its first frames, where the live app begins, so the swap
  // to it shows no jump and the plan arriving is the first thing to move.
  await boot(page, origin)
  await page.evaluate(settle)
  const png = await page.screenshot({ type: "png" })
  // The browser already does WebP, so no image library is needed. It does so on a blank
  // page, which the app's content security policy doesn't reach.
  const blank = await context.newPage()
  const webp = Buffer.from(
    await blank.evaluate(encode, { png: png.toString("base64"), quality }),
    "base64",
  )
  const name = `poster-${colorScheme}-${viewport.width * scale}.webp`
  await writeFile(join(root, name), webp)
  console.log(`${name}: ${webp.length} bytes`)
  await context.close()
}

// How long one boot of the demo takes on a slower CPU.
const bootOnce = async (browser: Browser, origin: string): Promise<number> => {
  const context = await browser.newContext({ viewport })
  try {
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle })
    const started = performance.now()
    await boot(page, origin)
    return Math.round(performance.now() - started)
  } finally {
    await context.close()
  }
}

// The median of `samples` boots, one after another, so one slow run fails nothing; above
// `bootBudgetMs` it fails.
const timeBoot = async (browser: Browser, origin: string): Promise<void> => {
  const took: number[] = []
  for (let run = 0; run < samples; run += 1)
    // eslint-disable-next-line no-await-in-loop -- Timed alone, one at a time.
    took.push(await bootOnce(browser, origin))
  const median = took.toSorted((a, b) => a - b)[Math.floor(samples / 2)]!
  console.log(
    `boot at ${throttle}x CPU: median ${median} ms of ${took.join(", ")} (budget ${bootBudgetMs} ms)`,
  )
  if (median > bootBudgetMs)
    throw new Error(`The demo booted in ${median} ms, over its ${bootBudgetMs} ms budget`)
}

export const main = async (directory = "dist"): Promise<void> => {
  const root = resolve(directory)
  const { origin, stop } = await serve(root)
  // The server stops on any failure, a browser that won't launch included, so the
  // process exits rather than waiting on it.
  try {
    const browser = await chromium.launch()
    try {
      // Timed alone, so the posters' captures don't share its CPU.
      await timeBoot(browser, origin)
      await Promise.all(
        schemes.flatMap((scheme) =>
          scales.map((scale) => capture(browser, origin, root, scheme, scale)),
        ),
      )
    } finally {
      await browser.close()
    }
  } finally {
    await stop()
  }
}

if (import.meta.main) {
  try {
    await main(process.argv[2])
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
