// What a live page shown at a phone's size is told it runs on, where its app can tell it:
// a phone's screen, `phoneScreen`, touched rather than pointed at, in a phone's browser. Its
// view is as big as it's drawn and its page zoomed to lay out a screen wide (see
// `phoneEmulation`). The
// viewer names its view a phone's by `phoneUserAgent` (../browser.ts), and the desktop app's
// lockdown makes it act as one by `phoneEmulation` (./host.ts); both are made of one
// Chromium, so they agree on its version.

/** A phone's screen, in CSS pixels. */
export const phoneScreen = { width: 390, height: 844 } as const

/** Put in a phone's page: no scrollbar of its own, as a phone's floats over the page. */
export const phoneStyle = "html { scrollbar-width: none !important; }"

/**
 * The user agent of Chrome on an Android phone, as Chrome gives it now, reduced: its major
 * version, `major`, and nothing a site could tell one phone from another by.
 */
export const phoneUserAgent = (major: string): string =>
  `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`

/** The major version of the Chromium a user agent names, or "0" for one that names none. */
export const chromeMajorOf = (userAgent: string): string =>
  /\bChrome\/(\d+)/.exec(userAgent)?.[1] ?? "0"

/**
 * The DevTools protocol commands that make a page view a phone's, for Chromium `version`:
 * a page that reports a phone's screen, its scrollbars over the page, touched, and in a
 * phone's browser in its user agent and client hints. Its viewport is the view's own, not a
 * phone's screen set apart from it, so that the viewer can draw the view as big as the phone
 * is drawn and zoom the page to lay it out a screen wide: Chromium places a page's popups (a
 * select's list, a date's picker) by the view's box and the page's zoom, and a viewport
 * emulated at another size, or scaled by the protocol, puts them where it isn't. The cost is
 * that the page's `<meta viewport>` isn't read, as a mobile viewport would: one with none,
 * or a fixed width, lays out a screen wide, not as the phone's browser would lay it out
 * and scale it. The mouse touching it is `phoneTouch`, apart, as that reaches past the view.
 */
export const phoneEmulation = (
  version: string,
): readonly (readonly [method: string, params: Record<string, unknown>])[] => {
  const major = chromeMajorOf(`Chrome/${version}`)
  return [
    [
      "Emulation.setDeviceMetricsOverride",
      {
        width: 0,
        height: 0,
        deviceScaleFactor: 0,
        mobile: false,
        screenWidth: phoneScreen.width,
        screenHeight: phoneScreen.height,
      },
    ],
    ["Emulation.setScrollbarsHidden", { hidden: true }],
    ["Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }],
    [
      "Emulation.setUserAgentOverride",
      {
        userAgent: phoneUserAgent(major),
        userAgentMetadata: {
          brands: [
            { brand: "Chromium", version: major },
            { brand: "Not.A/Brand", version: "99" },
          ],
          fullVersion: version,
          platform: "Android",
          platformVersion: "10.0.0",
          architecture: "",
          model: "K",
          mobile: true,
        },
      },
    ],
  ]
}

/**
 * The DevTools protocol command that makes the mouse touch, as a finger on a phone would, or
 * point again. Chromium has one such switch for a whole window, its page views included:
 * sent to a page view, it turns the mouse to touch over the app's own page too.
 */
export const phoneTouch = (
  on: boolean,
): readonly [method: string, params: Record<string, unknown>] => [
  "Emulation.setEmitTouchEventsForMouse",
  on ? { enabled: true, configuration: "mobile" } : { enabled: false },
]
