import { act, createElement, StrictMode } from "react"
import { afterEach, vi } from "vitest"

import type {
  Backend,
  BackendConnection,
  BackendSelection,
  BootProgress,
  ConnectFailure,
} from "../backend/port"
import { createStore } from "../model/store"
import { context, describe, expect, it } from "../test"
import { render, type Rendered } from "../test/render"
import { BackendGate } from "./BackendGate"
import { onlineHoldMs, splashFadeMs } from "./boot"

const mounted: Rendered[] = []
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.useRealTimers()
})

const createBackend = (): Backend => {
  throw new Error("not created in these tests")
}

// A connection the test settles by hand, counting how often each attempt was closed.
const pending = () => {
  const attempts: {
    readonly signal: AbortSignal
    readonly loading: () => void
    readonly resolve: (connection: BackendConnection) => void
    readonly reject: (error: Error) => void
  }[] = []
  const selection: BackendSelection = {
    connect: (signal, progress) =>
      new Promise((resolve, reject) =>
        attempts.push({ signal, loading: () => progress("loading"), resolve, reject }),
      ),
  }
  return { selection, attempts }
}

// The gate with a workspace that hands out its boot report.
const show = (selection: BackendSelection) => {
  const reports: ((progress: BootProgress) => void)[] = []
  const page = render(
    createElement(
      StrictMode,
      null,
      createElement(BackendGate, {
        selection,
        render: (_create, boot) => {
          reports.push(boot)
          return createElement("p", null, "workspace")
        },
      }),
    ),
  )
  mounted.push(page)
  const phase = () => page.container.querySelector("[role=status]")?.textContent ?? null
  const report = (progress: BootProgress) => act(() => reports.at(-1)!(progress))
  return { ...page, phase, report }
}

// A rejected connect carrying the failure the adapter would report.
const failing = (kind: ConnectFailure["kind"], code: string) =>
  Object.assign(new Error("failed"), {
    failure: {
      kind,
      message:
        kind === "incompatible"
          ? "This runner is from a different Novadeck version."
          : "The runner didn't start.",
      code,
      detail: `runner said ${code}`,
    } satisfies ConnectFailure,
  })

describe("backend gate", () => {
  context("while the backend connects", () => {
    it("shows the splash powering up", () => {
      const { phase } = show(pending().selection)
      expect(phase()).toBe("Powering the deck…")
    })

    it("says it is jacking in once the workspace loads", () => {
      const { selection, attempts } = pending()
      const { phase } = show(selection)
      act(() => attempts.at(-1)!.loading())
      expect(phase()).toBe("Jacking in…")
    })
  })

  context("once connected", () => {
    const connected = async () => {
      const { selection, attempts } = pending()
      const page = show(selection)
      let closed = 0
      await act(async () => attempts.at(-1)!.resolve({ createBackend, close: () => closed++ }))
      return { ...page, closed: () => closed }
    }

    it("mounts the workspace behind the splash and counts the real attaches", async () => {
      const page = await connected()
      expect(page.container.textContent).toContain("workspace")
      page.report({ attached: 1, total: 3, done: false })
      expect(page.phase()).toBe("Attaching terminals 1 of 3")
    })

    it("lifts the splash once the terminals are attached", async () => {
      const page = await connected()
      vi.useFakeTimers()
      page.report({ attached: 3, total: 3, done: true })
      act(() => vi.advanceTimersByTime(0))
      expect(page.phase()).toBe("Deck online")
      act(() => vi.advanceTimersByTime(onlineHoldMs + splashFadeMs))
      expect(page.phase()).toBeNull()
      expect(page.container.textContent).toBe("workspace")
    })

    it("closes the connection when unmounted", async () => {
      const page = await connected()
      page.unmount()
      mounted.splice(0)
      expect(page.closed()).toBe(1)
    })

    it("closes a connection StrictMode abandoned", async () => {
      const { selection, attempts } = pending()
      show(selection)
      expect(attempts.map((attempt) => attempt.signal.aborted)).toEqual([true, false])
      let closed = 0
      await act(async () => attempts[0]!.resolve({ createBackend, close: () => closed++ }))
      expect(closed).toBe(1)
    })
  })

  context("when connecting fails", () => {
    const failed = async (kind: ConnectFailure["kind"], code: string) => {
      const { selection, attempts } = pending()
      const page = show(selection)
      const fail = () => act(async () => attempts.at(-1)!.reject(failing(kind, code)))
      await fail()
      const alert = () => page.container.querySelector("[role=alert]")
      const button = (name: string) =>
        [...page.container.querySelectorAll("button")].find((item) => item.textContent === name)
      return { ...page, attempts, fail, alert, button }
    }

    it("explains it in place of the phase line, keeping the splash", async () => {
      const page = await failed("transient", "DISCONNECTED")
      expect(page.alert()?.textContent).toContain("Couldn't power the deck")
      expect(page.alert()?.textContent).toContain("The runner didn't start.")
      expect(page.container.querySelector("[aria-busy]")).not.toBeNull()
      // The name stays whole: the lockup stands in its finished state.
      expect(page.container.querySelector("[data-state]")?.getAttribute("data-state")).toBe(
        "failed",
      )
      expect(page.container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
        "novadeck.",
      )
    })

    it("keeps the lockup finished through a retry instead of replaying its entrance", async () => {
      vi.useFakeTimers()
      const page = await failed("transient", "DISCONNECTED")
      await act(async () => vi.advanceTimersByTime(2_000))
      expect(page.container.querySelector("[data-state]")?.getAttribute("data-state")).toBe(
        "settled",
      )
    })

    it("retries a transient failure on its own after 2, 4 and 8 s, then waits", async () => {
      vi.useFakeTimers()
      const page = await failed("transient", "DISCONNECTED")
      for (const seconds of [2, 4, 8]) {
        expect(page.alert()?.textContent).toContain(`Retrying in ${seconds} s…`)
        const before = page.attempts.length
        // eslint-disable-next-line no-await-in-loop -- Each retry follows the last failure.
        await act(async () => vi.advanceTimersByTime(seconds * 1000))
        expect(page.attempts.length).toBeGreaterThan(before)
        expect(page.phase()).toBe("Powering the deck…")
        // eslint-disable-next-line no-await-in-loop -- Each retry follows the last failure.
        await page.fail()
      }
      expect(page.alert()?.textContent).not.toContain("Retrying in")
      const before = page.attempts.length
      await act(async () => vi.advanceTimersByTime(30_000))
      expect(page.attempts.length).toBe(before)
    })

    it("starts the sequence over on Retry now", async () => {
      vi.useFakeTimers()
      const page = await failed("transient", "DISCONNECTED")
      await act(async () => vi.advanceTimersByTime(2_000))
      await page.fail()
      expect(page.alert()?.textContent).toContain("Retrying in 4 s…")
      act(() => page.button("Retry now")!.click())
      expect(page.phase()).toBe("Powering the deck…")
      await page.fail()
      expect(page.alert()?.textContent).toContain("Retrying in 2 s…")
    })

    it("continues into the normal boot once a retry connects", async () => {
      vi.useFakeTimers()
      const page = await failed("transient", "DISCONNECTED")
      await act(async () => vi.advanceTimersByTime(2_000))
      await act(async () => page.attempts.at(-1)!.resolve({ createBackend, close: () => {} }))
      expect(page.container.textContent).toContain("workspace")
      expect(page.alert()).toBeNull()
    })

    it("offers only Quit for a runner from another version", async () => {
      const close = vi.spyOn(window, "close").mockImplementation(() => {})
      const page = await failed("incompatible", "INCOMPATIBLE_PROTOCOL")
      expect(page.alert()?.textContent).toContain(
        "This runner is from a different Novadeck version.",
      )
      expect(page.alert()?.textContent).not.toContain("Retrying in")
      expect(page.button("Retry now") ?? page.button("Retry")).toBeUndefined()
      act(() => page.button("Quit")!.click())
      expect(close).toHaveBeenCalled()
      expect(page.container.textContent).toBe("")
    })

    it("waits for Retry when the runner refuses the app", async () => {
      vi.useFakeTimers()
      const page = await failed("unauthorized", "UNAUTHORIZED")
      expect(page.button("Retry")).toBeDefined()
      const before = page.attempts.length
      await act(async () => vi.advanceTimersByTime(30_000))
      expect(page.attempts.length).toBe(before)
      act(() => page.button("Retry")!.click())
      expect(page.attempts.length).toBeGreaterThan(before)
    })

    it("shows and copies the details", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
      const page = await failed("unauthorized", "UNAUTHORIZED")
      act(() => page.button("Details")!.click())
      expect(page.alert()?.textContent).toContain("UNAUTHORIZED")
      expect(page.alert()?.textContent).toContain("runner said UNAUTHORIZED")
      await act(async () => page.button("Copy details")!.click())
      expect(writeText).toHaveBeenCalledWith(
        "Code: UNAUTHORIZED\nMessage: runner said UNAUTHORIZED\nAttempts: 1",
      )
      expect(page.button("Copied")).toBeDefined()
    })
  })

  context("when the debug panel asks for a fresh boot", () => {
    it("drops the workspace and runs the start again from the splash", async () => {
      const reboots = createStore(0)
      const { selection, attempts } = pending()
      const page = show({ ...selection, reboots } as BackendSelection)
      await act(async () => attempts.at(-1)!.resolve({ createBackend, close: () => {} }))
      expect(page.container.textContent).toContain("workspace")
      const before = attempts.length
      act(() => void reboots.update((count) => count + 1))
      expect(attempts.length).toBeGreaterThan(before)
      expect(page.phase()).toBe("Powering the deck…")
      expect(page.container.textContent).not.toContain("workspace")
    })
  })

  context("when a rehearsal boots again after a failure", () => {
    it("replays the start like a launch: lockup animating, attempts from one", async () => {
      vi.useFakeTimers()
      const reboots = createStore(0)
      const { selection, attempts } = pending()
      const page = show({ ...selection, reboots } as BackendSelection)
      await act(async () => attempts.at(-1)!.reject(failing("unauthorized", "UNAUTHORIZED")))
      act(() => void reboots.update((count) => count + 1))
      expect(page.container.querySelector("[data-state]")?.getAttribute("data-state")).toBe(
        "booting",
      )
      await act(async () => attempts.at(-1)!.reject(failing("unauthorized", "UNAUTHORIZED")))
      const details = [...page.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Details",
      )!
      act(() => details.click())
      expect(page.container.querySelector("[role=alert]")?.textContent).toContain("Attempts1")
    })
  })

  context("with a backend that needs no connection", () => {
    it("renders the workspace at once, without a splash", () => {
      const { container, phase } = show({ createBackend })
      expect(container.textContent).toBe("workspace")
      expect(phase()).toBeNull()
    })
  })
})
