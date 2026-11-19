// What the browser viewer runs in a live page, as source for its view's
// `executeJavaScript`: reading where it's scrolled, scrolling it back, and bringing a show's
// element into view.

// Run in the page: what its `<meta name="viewport">` says, or null where it has none.
export const viewportRead = `document.querySelector('meta[name="viewport" i]')?.getAttribute("content") ?? null`

/**
 * Whether what a page's viewport tag says (see `viewportRead`) lays it out a screen wide, as
 * a phone does: `width=device-width`, among the tag's other settings. None, or a fixed width,
 * lays it out wider (980 without one) and shrinks it to fit.
 */
export const isMobileViewport = (content: unknown): boolean =>
  typeof content === "string" &&
  content.split(/[,;]/).some((part) => {
    const [name, value] = part.split("=").map((each) => each.trim().toLowerCase())
    return name === "width" && value === "device-width"
  })

/** A page's scroll, as `[scrollX, scrollY]`. */
export type Scrolled = readonly [number, number]

export const isScrolled = (value: unknown): value is Scrolled =>
  Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)

// Run in the page: where it's scrolled, read for at most `scrollReadMs`.
export const scrollRead = "[scrollX, scrollY]"
export const scrollReadMs = 500
/** How long a woken page's scroll waits for a page that draws itself to be tall enough. */
export const restoreWaitMs = 1_500
// Run in the page: back where it was scrolled, once the page is tall enough to be, as one
// that draws itself after loading grows, or after a while all the same.
export const scrolling = ([x, y]: Scrolled): string => `new Promise((done) => {
  const until = Date.now() + ${restoreWaitMs}
  const go = () => {
    const room = document.documentElement.scrollHeight - innerHeight
    if (room < ${y} && Date.now() < until) return requestAnimationFrame(go)
    scrollTo(${x}, ${y})
    done(true)
  }
  go()
})`

// Run in the page: brings the first element matching `selector` into view, as an #anchor
// would, once one is there, waiting up to `ms` for a page that draws itself after loading.
// A selector the page can't read finds nothing.
export const revealing = (selector: string, ms: number): string => `new Promise((done) => {
  const find = () => {
    try {
      return document.querySelector(${JSON.stringify(selector)})
    } catch {
      return null
    }
  }
  const reveal = (element) => {
    element.scrollIntoView({ block: "start" })
    done(true)
  }
  const found = find()
  if (found) return reveal(found)
  const watch = new MutationObserver(() => {
    const element = find()
    if (!element) return
    watch.disconnect()
    clearTimeout(timer)
    reveal(element)
  })
  const timer = setTimeout(() => {
    watch.disconnect()
    done(false)
  }, ${ms})
  watch.observe(document, { childList: true, subtree: true })
})`
