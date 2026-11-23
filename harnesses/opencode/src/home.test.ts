import { describe, expect, it } from "vitest"

import { dirs, home } from "./home.js"

describe("opencode's folders", () => {
  it("are under ~/.local/share, ~/.config, ~/.local/state and ~/.cache on every platform", () => {
    expect(dirs({ env: {}, home: "/h", platform: "darwin" })).toEqual({
      data: "/h/.local/share/opencode",
      config: "/h/.config/opencode",
      state: "/h/.local/state/opencode",
      cache: "/h/.cache/opencode",
    })
    expect(dirs({ env: {}, home: "C:\\U", platform: "win32" }).data).toBe(
      "C:\\U\\.local\\share\\opencode",
    )
  })

  it("move with the XDG variables of the person's environment", () => {
    const moved = dirs({
      env: { XDG_DATA_HOME: "/d", XDG_CACHE_HOME: "/c" },
      home: "/h",
      platform: "linux",
    })
    expect(moved).toMatchObject({
      data: "/d/opencode",
      cache: "/c/opencode",
      config: "/h/.config/opencode",
    })
  })

  it("has its home in the data folder", () => {
    expect(home({ env: { XDG_DATA_HOME: "/d" }, home: "/h", platform: "linux" })).toBe(
      "/d/opencode",
    )
  })
})
