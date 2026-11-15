import type { IpcMainInvokeEvent, NativeImage, Rectangle } from "electron"

import { panePictureChannel } from "../../bridge.js"

// How a picture of a pane is encoded: JPEG, as a page's picture is.
export const panePictureQuality = 85
// How long a picture may take: a window Chromium draws no frame for answers late or never.
export const panePictureWaitMs = 2_000
// The largest side of a pane pictured, in CSS pixels: no window is wider.
const largestSide = 16_384

/** The app's page, as a picture of its panes needs it. */
export type PicturedPage = {
  readonly capturePage: (rect: Rectangle) => Promise<NativeImage>
  readonly getZoomFactor: () => number
}

// A part of the page in CSS pixels of its viewport, or undefined where it isn't one.
const rectOf = (value: unknown): Rectangle | undefined => {
  const { x, y, width, height } = (value ?? {}) as Record<string, unknown>
  const sides = [x, y, width, height]
  if (!sides.every((side) => typeof side === "number" && Number.isFinite(side))) return undefined
  const [left, top, wide, high] = sides as number[]
  if (left! < 0 || top! < 0 || wide! < 1 || high! < 1) return undefined
  if (wide! > largestSide || high! > largestSide) return undefined
  return { x: left!, y: top!, width: wide!, height: high! }
}

/**
 * A picture of the part `rect` of the app's page as it's drawn now, in CSS pixels of its
 * viewport, as a JPEG `data:` address, `rect.width` pixels wide: one pixel to each CSS
 * pixel, as it's shown only a moment, where the pane it stands in for builds. Undefined
 * for anything but a part of the page, and where the window draws nothing.
 */
export const picturePane = async (
  page: PicturedPage,
  rect: unknown,
): Promise<string | undefined> => {
  const part = rectOf(rect)
  if (!part) return undefined
  // Electron's rectangle is in the window's own points, which the page's zoom scales.
  const zoom = page.getZoomFactor()
  const image = await within(
    page.capturePage({
      x: Math.round(part.x * zoom),
      y: Math.round(part.y * zoom),
      width: Math.round(part.width * zoom),
      height: Math.round(part.height * zoom),
    }),
    panePictureWaitMs,
  )
  if (!image || image.isEmpty()) return undefined
  const width = Math.round(part.width)
  const drawn = image.getSize().width > width ? image.resize({ width, quality: "good" }) : image
  return `data:image/jpeg;base64,${drawn.toJPEG(panePictureQuality).toString("base64")}`
}

type PanePictureIpc = {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, rect: unknown) => Promise<string | undefined>,
  ): unknown
}

/**
 * Answers the app's page asking for a picture of one of its panes, to stand in for it while
 * it builds again. `fromApp` tells a request of the app's own page from any other, which
 * gets none.
 */
export const registerPanePictureIpc = (
  ipc: PanePictureIpc,
  fromApp: (event: IpcMainInvokeEvent) => boolean,
): void => {
  ipc.handle(panePictureChannel, async (event, rect) =>
    fromApp(event) ? picturePane(event.sender, rect) : undefined,
  )
}

// What `promise` comes to within `ms`, else undefined, as when it fails.
const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    const done = (value: T | undefined): void => {
      clearTimeout(timer)
      resolve(value)
    }
    promise.then(done, () => done(undefined))
  })
