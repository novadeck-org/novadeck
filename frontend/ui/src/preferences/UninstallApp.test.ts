import type { OfferedUninstall, UninstallResult } from "@novadeck/core/uninstall"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { vi } from "vitest"

import { describe, expect, it } from "../test"
import { UninstallApp, type UninstallValue } from "./UninstallApp"

const ready: OfferedUninstall = {
  kind: "ready",
  dataFolders: ["/home/me/.config/novadeck", "/home/me/Novadeck"],
  handoff: "app",
}

const button = (name: string, within: ParentNode = document): HTMLButtonElement | undefined =>
  [...within.querySelectorAll("button")].find((candidate) => candidate.textContent === name)

const dialog = (): HTMLElement | null => document.querySelector("[role=alertdialog]")

const settle = (): Promise<void> =>
  act(async () => void (await new Promise((r) => setTimeout(r, 50))))

const mount = (
  plan: OfferedUninstall,
  options: {
    readonly connected?: readonly ("claude" | "codex")[]
    readonly run?: UninstallValue["run"]
    readonly quit?: () => void
  } = {},
) =>
  render(
    createElement(UninstallApp, {
      uninstall: {
        plan,
        connected: options.connected ?? [],
        run: options.run ?? (() => Promise.resolve({ kind: "removed" })),
        quit: options.quit ?? (() => {}),
      },
    }),
  )

const open = async (container: HTMLElement): Promise<void> => {
  await act(async () => {
    button("Uninstall…", container)?.click()
    await Promise.resolve()
  })
}

describe("the uninstall row of a package-managed copy", () => {
  it("gives the command to run and a Copy button, and nothing destructive", () => {
    const { container, unmount } = mount({
      kind: "manual",
      command: "brew uninstall --cask novadeck",
    })
    expect(container.textContent).toMatch(/Homebrew installed Novadeck/)
    expect(container.querySelector("code")?.textContent).toBe("brew uninstall --cask novadeck")
    expect(button("Copy", container)).toBeDefined()
    expect(button("Uninstall…", container)).toBeUndefined()
    unmount()
  })
})

describe("the uninstall dialog of a copy the app removes", () => {
  it("says what goes, naming the connected agents, and keeps data by default", async () => {
    const { container, unmount } = mount(ready, { connected: ["claude", "codex"] })
    expect(container.textContent).toMatch(/Uninstall Novadeck/)
    expect(container.textContent).toMatch(/Removes the app from this computer\./)
    await open(container)
    expect(dialog()?.textContent).toMatch(/Uninstall Novadeck\?/)
    expect(dialog()?.textContent).toMatch(
      /removed from this computer and disconnected from Claude Code and Codex\./,
    )
    expect(dialog()?.textContent).toMatch(/Running terminals will end/)
    expect(dialog()?.textContent).toMatch(/\/home\/me\/\.config\/novadeck/)
    const keep = dialog()?.querySelector<HTMLInputElement>("input[type=checkbox]")
    expect(keep?.checked).toBe(true)
    expect(button("Uninstall", dialog()!)).toBeDefined()
    unmount()
  })

  it("drops the agents sentence when none is connected", async () => {
    const { container, unmount } = mount(ready)
    await open(container)
    expect(dialog()?.textContent).not.toMatch(/disconnected/)
    unmount()
  })

  it("passes the data choice on, and shows Removing… while it works", async () => {
    let finish: (result: UninstallResult) => void = () => {}
    const run = vi.fn<() => Promise<UninstallResult>>(
      () => new Promise<UninstallResult>((resolve) => void (finish = resolve)),
    )
    const { container, unmount } = mount(ready, { run })
    await open(container)
    await act(async () =>
      dialog()?.querySelector<HTMLInputElement>("input[type=checkbox]")?.click(),
    )
    await act(async () => {
      button("Uninstall", dialog()!)?.click()
      await Promise.resolve()
    })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ keepData: false }))
    expect(button("Removing…", dialog()!)?.disabled).toBe(true)
    expect(button("Cancel", dialog()!)?.disabled).toBe(true)
    await act(async () => finish({ kind: "uninstalling" }))
    unmount()
  })

  it("stays open with the reason when it fails, and offers another try", async () => {
    const run = vi.fn<() => Promise<UninstallResult>>(() =>
      Promise.resolve({ kind: "failed", reason: "Disk busy." }),
    )
    const { container, unmount } = mount(ready, { run })
    await open(container)
    await act(async () => {
      button("Uninstall", dialog()!)?.click()
      await Promise.resolve()
    })
    await settle()
    expect(dialog()?.querySelector("[role=alert]")?.textContent).toBe("Disk busy.")
    expect(button("Uninstall", dialog()!)?.disabled).toBe(false)
    unmount()
  })

  it("ends on a closing message with no actions when the platform's uninstaller takes over", async () => {
    const { container, unmount } = mount(
      { ...ready, handoff: "uninstaller" },
      { run: () => Promise.resolve({ kind: "uninstalling" }) },
    )
    await open(container)
    expect(dialog()?.textContent).toMatch(/Windows' uninstaller finishes the job/)
    await act(async () => {
      button("Continue", dialog()!)?.click()
      await Promise.resolve()
    })
    await settle()
    expect(dialog()?.textContent).toMatch(/Novadeck is closing for its uninstaller\./)
    expect(dialog()?.querySelectorAll("button")).toHaveLength(0)
    unmount()
  })

  it("ends on uninstalled with the leftover command and Quit, which quits", async () => {
    const quit = vi.fn<() => void>()
    const { container, unmount } = mount(ready, {
      quit,
      run: () => Promise.resolve({ kind: "removed", leftover: "sudo rm /etc/apparmor.d/novadeck" }),
    })
    await open(container)
    await act(async () => {
      button("Uninstall", dialog()!)?.click()
      await Promise.resolve()
    })
    await settle()
    expect(dialog()?.textContent).toMatch(/Novadeck is uninstalled\./)
    expect(dialog()?.querySelector("code")?.textContent).toBe("sudo rm /etc/apparmor.d/novadeck")
    expect(button("Copy", dialog()!)).toBeDefined()
    expect(button("Cancel", dialog()!)).toBeUndefined()
    button("Quit", dialog()!)?.click()
    expect(quit).toHaveBeenCalledOnce()
    unmount()
  })

  it("has no Copy when nothing is left over", async () => {
    const { container, unmount } = mount(ready)
    await open(container)
    await act(async () => {
      button("Uninstall", dialog()!)?.click()
      await Promise.resolve()
    })
    await settle()
    expect(dialog()?.textContent).toMatch(/Novadeck is uninstalled\./)
    expect(button("Copy", dialog()!)).toBeUndefined()
    expect(button("Quit", dialog()!)).toBeDefined()
    unmount()
  })

  it("closes on Cancel", async () => {
    const { container, unmount } = mount(ready)
    await open(container)
    await act(async () => button("Cancel", dialog()!)?.click())
    await settle()
    expect(dialog()).toBeNull()
    unmount()
  })

  it("has no data choice, and keeps data, where the host has no data folder to offer", async () => {
    const run = vi.fn<(options: { keepData: boolean }) => Promise<UninstallResult>>(() =>
      Promise.resolve({ kind: "removed" }),
    )
    const { container, unmount } = mount({ ...ready, dataFolders: [] }, { run })
    await open(container)
    expect(dialog()?.querySelector("input[type=checkbox]")).toBeNull()
    expect(dialog()?.textContent).not.toMatch(/projects and sessions|Stays in/)
    await act(async () => {
      button("Uninstall", dialog()!)?.click()
      await Promise.resolve()
    })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ keepData: true }))
    await settle()
    unmount()
  })

  it("says which agents were disconnected when the removal then fails, and keeps naming them", async () => {
    const run = vi.fn<
      (options: {
        keepData: boolean
        onDisconnected: (agent: "claude" | "codex") => void
      }) => Promise<UninstallResult>
    >(({ onDisconnected }) => {
      onDisconnected("claude")
      onDisconnected("codex")
      return Promise.resolve({ kind: "failed", reason: "Disk busy." })
    })
    const { container, rerender, unmount } = mount(ready, { run, connected: ["claude", "codex"] })
    await open(container)
    await act(async () => {
      button("Uninstall", dialog()!)?.click()
      await Promise.resolve()
    })
    await settle()
    expect(dialog()?.querySelector("[role=alert]")?.textContent).toBe(
      "Disk busy. Claude Code and Codex were disconnected; connect them again in Preferences if you keep Novadeck.",
    )
    // The agents are off now, but the retry still names them.
    rerender(
      createElement(UninstallApp, {
        uninstall: { plan: ready, connected: [], run, quit: () => {} },
      }),
    )
    expect(dialog()?.textContent).toMatch(/disconnected from Claude Code and Codex\./)
    unmount()
  })
})
