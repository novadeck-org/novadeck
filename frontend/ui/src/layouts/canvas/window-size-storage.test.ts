import { afterEach } from "vitest"

import { describe, expect, it } from "../../test"
import {
  canvasWindowSizeStorageKey,
  readCanvasWindowSize,
  writeCanvasWindowSize,
} from "./window-size-storage"

afterEach(() => localStorage.removeItem(canvasWindowSizeStorageKey))

describe("readCanvasWindowSize", () => {
  it("opens new windows at 600×400 until one is resized", () => {
    expect(readCanvasWindowSize()).toEqual({ width: 600, height: 400 })
  })

  it("gives back the size a window was last given", () => {
    writeCanvasWindowSize({ width: 864, height: 528 })

    expect(readCanvasWindowSize()).toEqual({ width: 864, height: 528 })
  })

  it("falls back to 600×400 for a size no window could have", () => {
    for (const saved of [
      { width: 100, height: 400 },
      { width: 600, height: 0 },
      { width: "600", height: 400 },
      { width: 600 },
      [],
      "large",
    ]) {
      localStorage.setItem(canvasWindowSizeStorageKey, JSON.stringify(saved))

      expect(readCanvasWindowSize()).toEqual({ width: 600, height: 400 })
    }
    localStorage.setItem(canvasWindowSizeStorageKey, "{")
    expect(readCanvasWindowSize()).toEqual({ width: 600, height: 400 })
  })
})
