// What a live page shown at a phone's size is told it runs on, where its app can tell it:
// a phone's screen, `phoneScreen`, touched rather than pointed at, in a phone's browser. The
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
 * its viewport a phone's screen, laid out as a phone lays out (its `<meta viewport>` read,
 * its scrollbars over the page), a pointer that touches, and a phone's browser in its user
 * agent and client hints. Its pixels stay the screen's own.
 */
export const phoneEmulation = (
  version: string,
): readonly (readonly [method: string, params: Record<string, unknown>])[] => {
  const major = chromeMajorOf(`Chrome/${version}`)
  return [
    ["Emulation.setDeviceMetricsOverride", { ...phoneScreen, deviceScaleFactor: 0, mobile: true }],
    ["Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }],
    ["Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" }],
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
