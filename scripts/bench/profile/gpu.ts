import type { Page } from "playwright"

import { addonRegistry, lostCounter } from "./patches.ts"

// What the page says of its WebGL screens: how many are mounted and in view, which of them hold
// a WebGL context and whether it is lost, and, from the live WebGL addons the build's atlas
// patch registers (patches.ts), each texture atlas's pages and sizes and how many contexts hold
// it. Each context uploads its own copy of every page of the atlas it draws from, so the pages
// times the contexts is what the atlas costs in textures.

/** One texture atlas: xterm shares it between the terminals drawing with the same options. */
export type Atlas = {
  /** Each page's canvas size, in pixels. */
  readonly pages: readonly { readonly width: number; readonly height: number }[]
  /** Live addons (so contexts) holding the atlas. */
  readonly contexts: number
  /** All pages together, in MB at four bytes a pixel: one context's copy, mipmaps apart. */
  readonly pagesMB: number
}

export type GlReport = {
  /** Screens (`.xterm`) in the page: the terminals mounted. */
  readonly mounted: number
  /** Mounted screens at least half in the window's view. */
  readonly inView: number
  /** Screens with a canvas under `.xterm-screen` holding a WebGL 2 context. */
  readonly withContext: number
  /** Of those, the contexts already lost. */
  readonly contextLost: number
  /** Live WebGL addons, which the build's patch registers; null where it didn't. */
  readonly addons: number | null
  /** Contexts the addons have been told are lost, since the page loaded. */
  readonly lostEvents: number | null
  readonly atlases: readonly Atlas[]
  /** Every atlas's pages times its contexts: the atlas textures all contexts hold, in MB. */
  readonly atlasTexturesMB: number
  /** The first context's limits, as the GPU gives them. */
  readonly limits?: { readonly maxTextureSize: number; readonly maxTextureImageUnits: number }
}

/** Reads the page's WebGL screens and atlases. */
export const readGl = (page: Page): Promise<GlReport> =>
  page.evaluate(
    ([registry, lost]) => {
      type Pages = { canvas: { width: number; height: number } }[]
      type Addon = { _renderer?: { _charAtlas?: { pages: Pages } } }
      const screens = [...document.querySelectorAll(".xterm")]
      let inView = 0
      let withContext = 0
      let contextLost = 0
      let limits: GlReport["limits"]
      for (const screen of screens) {
        const box = screen.getBoundingClientRect()
        // What shows is the box inside the window and inside every ancestor that clips it,
        // as the Grid's scroller does for tiles scrolled away.
        let left = Math.max(box.left, 0)
        let right = Math.min(box.right, innerWidth)
        let top = Math.max(box.top, 0)
        let bottom = Math.min(box.bottom, innerHeight)
        for (let up = screen.parentElement; up; up = up.parentElement) {
          const style = getComputedStyle(up)
          if (style.overflowX === "visible" && style.overflowY === "visible") continue
          const clip = up.getBoundingClientRect()
          left = Math.max(left, clip.left)
          right = Math.min(right, clip.right)
          top = Math.max(top, clip.top)
          bottom = Math.min(bottom, clip.bottom)
        }
        const width = right - left
        const height = bottom - top
        if (box.width > 0 && box.height > 0 && width > 0 && height > 0)
          if ((width * height) / (box.width * box.height) >= 0.5) inView += 1
        // Asking a 2D canvas for WebGL gives nothing and creates nothing.
        const gl = [...screen.querySelectorAll<HTMLCanvasElement>(".xterm-screen canvas")]
          .map((canvas) => canvas.getContext("webgl2"))
          .find((each) => each !== null)
        if (gl) {
          withContext += 1
          if (gl.isContextLost()) contextLost += 1
          else
            limits ??= {
              maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
              maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
            }
        }
      }
      const live = (globalThis as unknown as Record<string, Set<Addon> | undefined>)[registry]
      const held = new Map<{ pages: Pages }, number>()
      for (const addon of live ?? []) {
        // eslint-disable-next-line no-underscore-dangle -- The addon's private fields, which a bench-only patch may read.
        const atlas = addon._renderer?._charAtlas
        if (atlas) held.set(atlas, (held.get(atlas) ?? 0) + 1)
      }
      const atlases = [...held].map(([atlas, contexts]) => {
        const pages = atlas.pages.map((each) => ({
          width: each.canvas.width,
          height: each.canvas.height,
        }))
        return {
          pages,
          contexts,
          pagesMB: pages.reduce((sum, one) => sum + one.width * one.height * 4, 0) / 1024 ** 2,
        }
      })
      return {
        mounted: screens.length,
        inView,
        withContext,
        contextLost,
        addons: live ? live.size : null,
        lostEvents: (globalThis as unknown as Record<string, number | undefined>)[lost] ?? null,
        atlases,
        atlasTexturesMB: atlases.reduce((sum, one) => sum + one.pagesMB * one.contexts, 0),
        ...(limits && { limits }),
      }
    },
    [addonRegistry, lostCounter] as const,
  )
