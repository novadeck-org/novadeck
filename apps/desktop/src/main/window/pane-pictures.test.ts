import type { IpcMainInvokeEvent, NativeImage, Rectangle } from "electron"

import { panePictureChannel } from "../../bridge.js"
import { describe, expect, it } from "../../test"
import { picturePane, registerPanePictureIpc, type PicturedPage } from "./pane-pictures"

// An image `width` by `height` pixels, whose JPEG is its size and, resized, what it was
// resized to.
const imageOf = (width: number, height: number, empty = false): NativeImage =>
  ({
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize: ({ width: to }: { width: number }) => imageOf(to, Math.round((height * to) / width)),
    toJPEG: () => Buffer.from(`${width}x${height}`),
  }) as unknown as NativeImage

// The app's page at `zoom`, its window drawn `scale` pixels to the point, noting each part
// it was asked to capture.
const pageOf = (zoom = 1, scale = 2, answer?: Promise<NativeImage>) => {
  const asked: Rectangle[] = []
  const page: PicturedPage = {
    getZoomFactor: () => zoom,
    capturePage: (rect) => {
      asked.push(rect)
      return answer ?? Promise.resolve(imageOf(rect.width * scale, rect.height * scale))
    },
  }
  return { page, asked }
}

const jpegOf = (text: string): string =>
  `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`

describe("a picture of a pane", () => {
  it("is of its part of the window, one pixel to each CSS pixel", async () => {
    const { page, asked } = pageOf()
    expect(await picturePane(page, { x: 10, y: 20, width: 300, height: 200 })).toBe(
      jpegOf("300x200"),
    )
    expect(asked).toEqual([{ x: 10, y: 20, width: 300, height: 200 }])
  })

  it("asks for the window's own points, which the page's zoom scales", async () => {
    const { page, asked } = pageOf(1.25, 1)
    expect(await picturePane(page, { x: 8, y: 16, width: 400, height: 240 })).toBe(
      jpegOf("400x240"),
    )
    expect(asked).toEqual([{ x: 10, y: 20, width: 500, height: 300 }])
  })

  it("is nothing for a part that isn't one of the page", async () => {
    const { page, asked } = pageOf()
    const parts = [
      undefined,
      "all",
      { x: 0, y: 0, width: 0, height: 10 },
      { x: -1, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: Number.NaN, height: 10 },
      { x: 0, y: 0, width: 100_000, height: 10 },
      { x: "0", y: 0, width: 10, height: 10 },
    ]
    const pictures = await Promise.all(parts.map((part) => picturePane(page, part)))
    expect(pictures).toEqual(parts.map(() => undefined))
    expect(asked).toEqual([])
  })

  it("is nothing where the window draws nothing", async () => {
    const { page } = pageOf(1, 1, Promise.resolve(imageOf(0, 0, true)))
    expect(await picturePane(page, { x: 0, y: 0, width: 10, height: 10 })).toBeUndefined()
  })

  it("is nothing where the capture fails", async () => {
    const { page } = pageOf(1, 1, Promise.reject(new Error("gone")))
    expect(await picturePane(page, { x: 0, y: 0, width: 10, height: 10 })).toBeUndefined()
  })
})

describe("answering the page's request for a picture of a pane", () => {
  const registered = (own: boolean) => {
    let listener: ((event: IpcMainInvokeEvent, rect: unknown) => Promise<unknown>) | undefined
    let channel: string | undefined
    registerPanePictureIpc(
      {
        handle: (name, handler) => {
          channel = name
          listener = handler
        },
      },
      () => own,
    )
    const { page } = pageOf(1, 1)
    const ask = (rect: unknown) =>
      listener!({ sender: page } as unknown as IpcMainInvokeEvent, rect)
    return { ask, channel }
  }

  it("pictures the part of the app's own page it asks for", async () => {
    const { ask, channel } = registered(true)
    expect(channel).toBe(panePictureChannel)
    expect(await ask({ x: 0, y: 0, width: 30, height: 20 })).toBe(jpegOf("30x20"))
  })

  it("gives any other sender none", async () => {
    const { ask } = registered(false)
    expect(await ask({ x: 0, y: 0, width: 30, height: 20 })).toBeUndefined()
  })
})
