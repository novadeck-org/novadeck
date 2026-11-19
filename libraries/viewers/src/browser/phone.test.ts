import { describe, expect, it } from "vitest"

import { phoneEmulation, phoneScreen } from "./phone.js"

describe("a phone's emulation", () => {
  const commands = new Map(phoneEmulation("145.0.1.2"))

  it("leaves the viewport the view's own, so the viewer can zoom the page to a screen's width", () => {
    // A viewport set to a screen's size apart from the view, or a mobile one, draws at that
    // size whatever the page's zoom, and puts a select's list or a date's picker where the
    // unscaled phone would.
    expect(commands.get("Emulation.setDeviceMetricsOverride")).toMatchObject({
      width: 0,
      height: 0,
      mobile: false,
    })
    expect(commands.get("Emulation.setDeviceMetricsOverride")).not.toHaveProperty("scale")
  })

  it("still says the screen is a phone's, and touched, with its scrollbars over the page", () => {
    expect(commands.get("Emulation.setDeviceMetricsOverride")).toMatchObject({
      screenWidth: phoneScreen.width,
      screenHeight: phoneScreen.height,
    })
    expect(commands.get("Emulation.setScrollbarsHidden")).toEqual({ hidden: true })
    expect(commands.get("Emulation.setTouchEmulationEnabled")).toMatchObject({ enabled: true })
  })
})
