import { describe, expect, it } from "vitest"

import { notificationsQuietChannel } from "../../bridge.js"
import {
  linuxProbe,
  notificationsQuiet,
  platformQuiet,
  registerQuietIpc,
  windowsProbe,
  type Run,
} from "./quiet"

// A command runner that answers by the command's name, and records what it ran.
const runs = (answers: Record<string, string | Error>) => {
  const ran: string[] = []
  const run: Run = async (file) => {
    ran.push(file)
    const answer = answers[file]
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error("missing")
    return answer
  }
  return { run, ran }
}

describe("the Linux probe", () => {
  it("reads GNOME's banner setting, quiet when banners are off", async () => {
    const { run, ran } = runs({ gsettings: "false\n" })
    expect(await linuxProbe(run, "ubuntu:GNOME")()).toBe(true)
    expect(ran).toEqual(["gsettings"])
    expect(await linuxProbe(runs({ gsettings: "true\n" }).run, "GNOME")()).toBe(false)
  })

  it("reads the notification server's Inhibited property elsewhere", async () => {
    expect(await linuxProbe(runs({ gdbus: "(<true>,)\n" }).run, "KDE")()).toBe(true)
    expect(await linuxProbe(runs({ gdbus: "(<false>,)\n" }).run, "KDE")()).toBe(false)
    expect(await linuxProbe(runs({ gdbus: "(<true>,)\n" }).run, undefined)()).toBe(true)
  })

  it("reads XFCE's do-not-disturb property", async () => {
    const { run, ran } = runs({ "xfconf-query": "true\n" })
    expect(await linuxProbe(run, "XFCE")()).toBe(true)
    expect(ran).toContain("xfconf-query")
    expect(await linuxProbe(runs({ "xfconf-query": "false\n" }).run, "XFCE")()).toBe(false)
  })

  it("reads dunst's pause wherever the desktop does not name a setting", async () => {
    expect(await linuxProbe(runs({ dunstctl: "true\n" }).run, "i3")()).toBe(true)
    expect(await linuxProbe(runs({ dunstctl: "false\n" }).run, undefined)()).toBe(false)
    expect(await linuxProbe(runs({ dunstctl: "true\n" }).run, "XFCE")()).toBe(true)
  })

  it("reads a missing program or a failed call as not quiet", async () => {
    expect(await linuxProbe(runs({}).run, "KDE")()).toBe(false)
    expect(await linuxProbe(runs({}).run, "GNOME")()).toBe(false)
    expect(await linuxProbe(runs({}).run, "XFCE")()).toBe(false)
  })
})

describe("the answer to the page", () => {
  it("is false where the platform has no probe", async () => {
    expect(await notificationsQuiet(undefined)()).toBe(false)
  })

  it("is false when the probe fails", async () => {
    expect(await notificationsQuiet(() => Promise.reject(new Error("x")))()).toBe(false)
  })

  it("keeps an answer for a few seconds, then asks again", async () => {
    let time = 0
    let asked = 0
    let quiet = true
    const ask = notificationsQuiet(
      async () => {
        asked += 1
        return quiet
      },
      () => time,
    )
    expect(await ask()).toBe(true)
    quiet = false
    time = 2000
    expect(await ask()).toBe(true)
    time = 4000
    expect(await ask()).toBe(false)
    expect(asked).toBe(2)
  })

  it("gives the last answer it knows when the probe is slower than the page waits", async () => {
    let slow = false
    const ask = notificationsQuiet(
      () => (slow ? new Promise<boolean>(() => {}) : Promise.resolve(true)),
      (() => {
        let time = 0
        return () => (time += 10_000)
      })(),
      10,
    )
    expect(await ask()).toBe(true)
    slow = true
    expect(await ask()).toBe(true)
  })

  it("has macOS read as not quiet", async () => {
    expect(await platformQuiet("darwin").quiet()).toBe(false)
  })
})

describe("the Windows probe", () => {
  it("is quiet while the shell's state is above 0", async () => {
    expect(await windowsProbe(async () => 2)()).toBe(true)
    expect(await windowsProbe(async () => 0)()).toBe(false)
  })

  it("reads as not quiet when the state is unavailable or the query fails", async () => {
    expect(await windowsProbe(async () => undefined)()).toBe(false)
    expect(await windowsProbe(() => Promise.reject(new Error("no ntdll")))()).toBe(false)
  })

  it("warns of a failing query once, however often it fails", async () => {
    const warned: unknown[] = []
    const failure = new Error("no koffi")
    const probe = windowsProbe(
      () => Promise.reject(failure),
      (error) => void warned.push(error),
    )
    await probe()
    await probe()
    expect(warned).toEqual([failure])
  })
})

describe("the platforms", () => {
  const never = () => Promise.reject(new Error("must not be asked"))

  it("asks Linux and macOS nothing of the Windows call, and macOS nothing at all", async () => {
    const { run, ran } = runs({ gsettings: "false\n" })
    const linux = platformQuiet("linux", { XDG_CURRENT_DESKTOP: "GNOME" }, run, never)
    expect(await linux.quiet()).toBe(true)
    const darwin = platformQuiet("darwin", {}, run, never)
    darwin.warm()
    expect(await darwin.quiet()).toBe(false)
    expect(ran).toEqual(["gsettings"])
  })

  it("asks Windows nothing of the commands", async () => {
    const { run, ran } = runs({})
    expect(await platformQuiet("win32", {}, run, async () => true).quiet()).toBe(true)
    expect(ran).toEqual([])
  })

  it("warms the answer ahead of the page's first question", async () => {
    let asked = 0
    const win = platformQuiet("win32", {}, undefined, async () => (asked += 1) > 0)
    win.warm()
    expect(asked).toBe(1)
    expect(await win.quiet()).toBe(true)
    expect(asked).toBe(1)
  })
})

describe("taking the page's question", () => {
  const registered = (own: boolean, quiet: () => Promise<boolean>) => {
    const handlers = new Map<string, (event: never) => unknown>()
    registerQuietIpc(
      { handle: (channel, listener) => void handlers.set(channel, listener as never) },
      { window: () => (own ? "window" : undefined), quiet },
    )
    return () => handlers.get(notificationsQuietChannel)!({} as never)
  }

  it("answers the app's own page", async () => {
    expect(await registered(true, async () => true)()).toBe(true)
  })

  it("answers false to any other sender, and when asking fails", async () => {
    expect(await registered(false, async () => true)()).toBe(false)
    expect(await registered(true, () => Promise.reject(new Error("x")))()).toBe(false)
  })
})
