import type { ForgeName } from "@novadeck/core/forges"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { createElement, type ComponentProps } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import type { ForgeRow } from "./forge-rows"
import { ForgeRows } from "./ForgeRows"

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((page) => page.unmount()))

const forge = (name: ForgeName, extra: Partial<ForgeRow> = {}): ForgeRow => ({
  forge: name,
  available: true,
  enabled: true,
  busy: false,
  hosts: [],
  ...extra,
})

const show = (props: Partial<ComponentProps<typeof ForgeRows>> & { forges: ForgeRow[] }) => {
  const page = render(createElement(ForgeRows, props))
  mounted.push(page)
  const q = <T extends Element>(selector: string) => page.container.querySelector<T>(selector)
  return { page, q }
}

describe("the forge rows", () => {
  it("has a row per forge, noting what it reads with, and no switch", () => {
    const { page, q } = show({ forges: [forge("github")] })
    expect(q("#forge-github-note")?.textContent).toBe("Uses your signed-in gh")
    expect(q('[role="switch"]')).toBeNull()
    expect(page.container.textContent).toContain("GitHub")
  })

  it("lists a forge's hosts, with Sign in only for a signed-out one", () => {
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

  it("shows no hosts under a forge whose tool is gone, and no Sign in without a way to run it", () => {
    const hosts = [{ host: "gitlab.com", state: "signed-out" as const, fix: "glab auth login" }]
    const gone = show({
      forges: [forge("gitlab", { available: false, hosts })],
      onSignIn: () => {},
    })
    expect(gone.q("[data-forge-host]")).toBeNull()
    const noRunner = show({ forges: [forge("gitlab", { hosts })] })
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

  it("offers Install with the command, and reads as installing", () => {
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

  it("names the tool a forge needs where nothing installs it", () => {
    const { q } = show({ forges: [forge("github", { available: false })] })
    expect(q("#forge-github-note")?.textContent).toBe("Not installed. Needs gh")
    expect(q("[data-forge-install]")).toBeNull()
  })

  it("shows a failed look as an alert", () => {
    const failed = show({ forges: [forge("github", { error: "could not read its token" })] })
    expect(failed.q('[role="alert"]')?.textContent).toBe("could not read its token")
  })
})
