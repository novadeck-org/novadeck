import type { ForgeName } from "@novadeck/core/forges"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { createElement, type ComponentProps } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import type { ForgeSwitch } from "./forge-switches"
import { ForgeSwitches } from "./ForgeSwitches"

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((page) => page.unmount()))

const forge = (name: ForgeName, extra: Partial<ForgeSwitch> = {}): ForgeSwitch => ({
  forge: name,
  available: true,
  enabled: false,
  busy: false,
  hosts: [],
  ...extra,
})

const show = (props: Partial<ComponentProps<typeof ForgeSwitches>> & { forges: ForgeSwitch[] }) => {
  const page = render(createElement(ForgeSwitches, { onChange: () => {}, ...props }))
  mounted.push(page)
  const q = <T extends Element>(selector: string) => page.container.querySelector<T>(selector)
  return { page, q }
}

describe("the forge switches", () => {
  it("has a switch per forge that can be switched, noting what it reads with", () => {
    const onChange = vi.fn<(forge: ForgeName, enabled: boolean) => void>()
    const { page, q } = show({ forges: [forge("github")], onChange })
    expect(q("#forge-github-note")?.textContent).toBe("Uses your signed-in gh")
    const toggle = q<HTMLElement>('[role="switch"]')!
    expect(toggle.getAttribute("aria-labelledby")).toBe("forge-github")
    toggle.click()
    expect(onChange).toHaveBeenCalledWith("github", true)
    expect(page.container.textContent).toContain("GitHub")
  })

  it("lists an enabled forge's hosts, with Sign in only for a signed-out one", () => {
    const onSignIn = vi.fn<(forge: ForgeName, host: string, command: string) => void>()
    const { q, page } = show({
      forges: [
        forge("github", {
          enabled: true,
          hosts: [
            { host: "github.com", state: "signed-in" },
            {
              host: "ghe.acme.dev",
              state: "signed-out",
              fix: "gh auth login --hostname ghe.acme.dev",
            },
            {
              host: "old.acme.dev",
              state: "refused",
              fix: "gh auth refresh --hostname old.acme.dev",
            },
          ],
        }),
      ],
      onSignIn,
    })
    const hosts = [...page.container.querySelectorAll("[data-forge-host]")]
    expect(hosts.map((host) => host.textContent)).toEqual([
      "github.com·Signed in",
      "ghe.acme.dev·Signed outSign in",
      "old.acme.dev·Token refusedgh auth refresh --hostname old.acme.dev",
    ])
    const buttons = page.container.querySelectorAll<HTMLButtonElement>("[data-forge-sign-in]")
    expect(buttons).toHaveLength(1)
    expect(q("[data-forge-sign-in]")?.getAttribute("aria-label")).toBe(
      "Sign in to ghe.acme.dev with GitHub",
    )
    buttons[0]!.click()
    expect(onSignIn).toHaveBeenCalledWith(
      "github",
      "ghe.acme.dev",
      "gh auth login --hostname ghe.acme.dev",
    )
  })

  it("shows no hosts under a forge that is off, and no Sign in without a way to run it", () => {
    const hosts = [{ host: "gitlab.com", state: "signed-out" as const, fix: "glab auth login" }]
    const off = show({ forges: [forge("gitlab", { hosts })], onSignIn: () => {} })
    expect(off.q("[data-forge-host]")).toBeNull()
    const noRunner = show({ forges: [forge("gitlab", { enabled: true, hosts })] })
    expect(noRunner.q("[data-forge-host]")).not.toBeNull()
    expect(noRunner.q("[data-forge-sign-in]")).toBeNull()
  })

  it("reads as signing in, and takes no clicks, while the sign-in runs", () => {
    const onSignIn = vi.fn<(forge: ForgeName, host: string, command: string) => void>()
    const { q } = show({
      forges: [
        forge("gitlab", {
          enabled: true,
          hosts: [{ host: "gitlab.com", state: "signed-out", fix: "glab auth login" }],
        }),
      ],
      onSignIn,
      signingIn: new Set(["gitlab/gitlab.com"]),
    })
    const button = q<HTMLButtonElement>("[data-forge-sign-in]")!
    expect(button.textContent).toBe("Signing in…")
    expect(button.getAttribute("aria-disabled")).toBe("true")
    button.click()
    expect(onSignIn).not.toHaveBeenCalled()
  })

  it("offers Install with the command in place of the switch, and reads as installing", () => {
    const onInstall = vi.fn<(forge: ForgeName, command: string) => void>()
    const missing = forge("azure", { available: false, installer: "brew install azure-cli" })
    const { q, page } = show({ forges: [missing], onInstall })
    expect(q('[role="switch"]')).toBeNull()
    expect(q("#forge-azure-note")?.textContent).toContain("brew install azure-cli")
    q<HTMLButtonElement>("[data-forge-install]")!.click()
    expect(onInstall).toHaveBeenCalledWith("azure", "brew install azure-cli")
    page.unmount()
    mounted.pop()
    const running = show({ forges: [missing], onInstall, installing: new Set(["azure"]) })
    const button = running.q<HTMLButtonElement>("[data-forge-install]")!
    expect(button.textContent).toBe("Installing…")
    button.click()
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it("names the tool a forge needs where nothing installs it, with its switch disabled", () => {
    const { q } = show({ forges: [forge("github", { available: false })] })
    expect(q("#forge-github-note")?.textContent).toBe("Not installed. Needs gh")
    expect(q('[role="switch"]')?.hasAttribute("disabled")).toBe(true)
  })

  it("shows a failed switch as an alert, and a pending one as busy", () => {
    const failed = show({ forges: [forge("github", { error: "could not read its token" })] })
    expect(failed.q('[role="alert"]')?.textContent).toBe("could not read its token")
    const busy = show({ forges: [forge("github", { busy: true })] })
    expect(busy.q('[role="switch"]')?.hasAttribute("disabled")).toBe(true)
    expect(busy.q("#forge-github-note")?.textContent).toBe("Switching on…")
  })
})
