import { afterEach, beforeEach, onTestFailed, vi } from "vitest"
import { page, type Locator } from "vitest/browser"

import { preferencesDialog, pressShortcut } from "../support/keyboard"
import {
  chooseView,
  clickInto,
  commandInput,
  draftOf,
  expectStaysAbsent,
  labelled,
  openWorkspace,
  press,
  skipWelcome,
  terminal,
  terminalTab,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

// A microphone made of an oscillator, so the specs record without hardware or a permission
// prompt. Count audio delivered by the capture worklet too: a live track alone doesn't
// mean its asynchronously loaded worklet has started recording.
const fakeMicrophone = () => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  const Worklet = AudioWorkletNode
  const tracks: MediaStreamTrack[] = []
  const contexts: AudioContext[] = []
  let seconds = 0
  window.AudioWorkletNode = class extends Worklet {
    constructor(audio: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(audio, name, options)
      this.port.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (event.data instanceof Float32Array) seconds += event.data.length / audio.sampleRate
      })
    }
  }
  navigator.mediaDevices.getUserMedia = async () => {
    const audio = new AudioContext()
    contexts.push(audio)
    const oscillator = audio.createOscillator()
    const destination = audio.createMediaStreamDestination()
    oscillator.connect(destination)
    oscillator.start()
    tracks.push(...destination.stream.getTracks())
    return destination.stream
  }
  return {
    live: () => tracks.filter((track) => track.readyState === "live").length,
    seconds: () => seconds,
    restore: () => {
      navigator.mediaDevices.getUserMedia = original
      window.AudioWorkletNode = Worklet
      for (const track of tracks) track.stop()
      for (const audio of contexts) void audio.close()
    },
  }
}

// Hold to dictate: Ctrl+Shift+M, on every platform.
const dictateKeys = "{Control>}{Shift>}{M>}"
const releaseKeys = "{/M}{/Shift}{/Control}"
// Deliver an immediate tap through the real key router with a fixed gesture clock.
// Automation RPCs or a stalled event handler otherwise turn it into a hold. The hold
// test below uses native keys; the state tests cover both sides of the 300 ms threshold.
const tapDictation = (): void => {
  const target = document.activeElement ?? document.body
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now())
  try {
    for (const type of ["keydown", "keyup"])
      target.dispatchEvent(
        new KeyboardEvent(type, {
          key: "M",
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
  } finally {
    clock.mockRestore()
  }
}
/** What the dictation strip shows now, its lines joined. */
const stripText = (): string =>
  page
    .getByRole("status")
    .elements()
    .filter((one) => one.classList.contains("dictation-strip"))
    .map((one) => one.textContent?.trim())
    .filter(Boolean)
    .join(" | ")

/** The dictation status line, once it says `text`. */
const saying = (text: string | RegExp): Locator =>
  page.getByRole("status").filter({ hasText: text })

/** Where an element stacks among its siblings' layer. */
const layer = (element: Element): number => Number(getComputedStyle(element).zIndex)

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))
/**
 * Waits for `until`, and where it fails says what the dictation strip showed meanwhile and
 * how many microphone tracks were live: a clip's notice fades in four seconds, long before a
 * wait for the words ends, and a clip too short to keep leaves none, so a failure would not
 * otherwise say which of them it was. `until` waits less than the test does, so this
 * reports before the test's own timeout does.
 */
const saidWhile = async (
  microphone: { readonly live: () => number },
  until: () => Promise<unknown>,
): Promise<void> => {
  const said: string[] = []
  const timer = setInterval(() => {
    const text = stripText()
    if (text && said.at(-1) !== text) said.push(text)
  }, 100)
  try {
    await until()
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `The status line said: ${said.length > 0 ? said.join(" → ") : "nothing"}; ` +
        `${microphone.live()} microphone track(s) live.`,
      { cause: error },
    )
  } finally {
    clearInterval(timer)
  }
}

/**
 * Records what dictation shows and the page's state for a whole test, every 50 ms and only
 * as it changes, and prints it where the test fails: its strip, the microphone's live tracks,
 * and whether the page has focus and shows. A failure of the first wait of a test, before
 * `saidWhile` is in place, would not otherwise say what the strip did meanwhile.
 */
const watchDictation = (microphone: { readonly live: () => number }): (() => void) => {
  const began = performance.now()
  const history: string[] = []
  let last = ""
  const note = (): void => {
    const strip = stripText()
    const now = `${strip || "-"} | ${microphone.live()} track(s) live | focus ${document.hasFocus()} | ${document.visibilityState}`
    if (now === last) return
    last = now
    history.push(`+${Math.round(performance.now() - began)} ms ${now}`)
  }
  const timer = setInterval(note, 50)
  onTestFailed(() => console.error(`Dictation, as it changed:\n${history.join("\n")}`))
  return () => clearInterval(timer)
}

describe("dictation", () => {
  let microphone: ReturnType<typeof fakeMicrophone>
  let unwatch: () => void
  beforeEach(() => {
    microphone = fakeMicrophone()
    unwatch = watchDictation(microphone)
  })
  afterEach(() => {
    unwatch()
    microphone.restore()
  })

  context("when voice input is not installed", () => {
    // The demo starts it installed, as the try demo shows it; the address asks for it without.
    const openWithoutVoice = async (route = "/?voice=uninstalled"): Promise<void> => {
      await openWorkspace(route)
      await skipWelcome()
    }
    // The offer, and the rest of voice input's setup, live in the terminal's dictation strip.
    const offer = (): Locator => saying("Talk to your agents")

    it("offers it in the strip when the shortcut is pressed, without recording or downloading", async () => {
      await openWithoutVoice()
      await clickInto("Checkout implementation")

      await press(`${dictateKeys}${releaseKeys}`)

      await expect.element(offer()).toBeVisible()
      await expect.element(offer().getByText(/runs on this computer/)).toBeVisible()
      await expect.element(offer().getByText(/\d+ MB once/)).toBeVisible()
      await expect.element(offer().getByRole("button", { name: "Turn on" })).toBeVisible()
      await expect.element(offer().getByRole("button", { name: "No thanks" })).toBeVisible()
      expect(microphone.live()).toBe(0)
      expect(page.getByText("Setting up voice input").query()).toBeNull()
      // Typing stays in the terminal: the strip took no focus.
      expect(document.activeElement).toBe(commandInput("Checkout implementation").element())
    })

    it("offers it again after it was ignored: typing hides it, which is not an answer", async () => {
      await openWithoutVoice()
      await clickInto("Checkout implementation")
      await press(`${dictateKeys}${releaseKeys}`)
      await expect.element(offer()).toBeVisible()

      await press("x")
      await expect.element(offer()).not.toBeInTheDocument()
      await press(`${dictateKeys}${releaseKeys}`)

      await expect.element(offer()).toBeVisible()
    })

    it("leaves Esc to the terminal while the offer shows", async () => {
      await openWithoutVoice()
      await clickInto("Checkout implementation")
      await press(`${dictateKeys}${releaseKeys}`)
      await expect.element(offer()).toBeVisible()

      // Esc reaches the terminal, where it interrupts the agent: nothing prevented it. The
      // document hears it after the app's window listeners and before the terminal's
      // emulator, which takes it as its own.
      const prevented: boolean[] = []
      const note = (event: KeyboardEvent): void => {
        if (event.key === "Escape") prevented.push(event.defaultPrevented)
      }
      document.addEventListener("keydown", note, true)
      try {
        await press("{Escape}")
      } finally {
        document.removeEventListener("keydown", note, true)
      }
      expect(prevented).toEqual([false])

      // The offer is only ignored, never answered by Esc.
      await press(`${dictateKeys}${releaseKeys}`)
      await expect.element(offer()).toBeVisible()
    })

    it("lets the keyboard reach the offer's buttons, and answers with Enter", async () => {
      await openWithoutVoice()
      await clickInto("Checkout implementation")
      await press(`${dictateKeys}${releaseKeys}`)
      await expect.element(offer()).toBeVisible()

      // Focus already in the strip (Tab from a terminal is the terminal's, and ignores the
      // offer; the shortcut again is the keyboard's yes): Enter answers its button.
      page.getByRole("button", { name: "No thanks" }).element().focus()
      expect(document.activeElement?.textContent).toBe("No thanks")
      await press("{Tab}")
      await expect.element(offer()).toBeVisible()
      page.getByRole("button", { name: "No thanks" }).element().focus()

      await press("{Enter}")

      await expect.element(offer()).not.toBeInTheDocument()
      // Turned down: the shortcut is no longer voice input's, so it offers nothing.
      await press(`${dictateKeys}${releaseKeys}`)
      await expectStaysAbsent(offer())
    })

    it("turns on when the shortcut is pressed again on a layout where M is elsewhere", async () => {
      await openWithoutVoice()
      await clickInto("Checkout implementation")
      await press(`${dictateKeys}${releaseKeys}`)
      await expect.element(offer()).toBeVisible()

      // AZERTY: the M key sits where QWERTY has the semicolon.
      const init = { key: "M", code: "Semicolon", ctrlKey: true, shiftKey: true, bubbles: true }
      window.dispatchEvent(new KeyboardEvent("keydown", init))
      window.dispatchEvent(new KeyboardEvent("keyup", init))

      await expect.element(saying("Setting up voice input")).toBeVisible()
    })

    it("makes room for the offer instead of covering the terminal's last lines", async () => {
      await openWithoutVoice()
      await clickInto("Checkout implementation")
      await press(`${dictateKeys}${releaseKeys}`)
      await expect.element(offer()).toBeVisible()

      const strip = document.querySelector<HTMLElement>(".dictation-strip:not([hidden])")!
      const content = strip.parentElement!.firstElementChild!.getBoundingClientRect()
      expect(content.bottom).toBeLessThanOrEqual(strip.getBoundingClientRect().top + 1)
    })

    it("fits in a short chat window, so nothing of it overflows, in each state of the setup", async () => {
      await page.viewport(900, 800)
      localStorage.setItem("novadeck.preferences", JSON.stringify({ chatView: true }))
      await openWithoutVoice("/?demo=agents&voice=failing&channel=experimental")
      await terminalTab("Checkout implementation").click()
      // Its own window, measured while it shows: a hidden one would measure 0 whatever happens.
      const win = (): HTMLElement =>
        terminal("Checkout implementation")
          .element()
          .closest<HTMLElement>("section.terminal-window")!
      const overflow = (): number => win().scrollHeight - win().clientHeight
      expect(win().clientHeight).toBeGreaterThan(0)
      const without = overflow()
      await terminal("Checkout implementation")
        .getByRole("button", {
          name: labelled("Set up voice input for ", "Checkout implementation"),
        })
        .click()
      await expect.element(offer()).toBeVisible()
      const strip = win().querySelector<HTMLElement>(".dictation-strip:not([hidden])")!
      const host = strip.parentElement!.getBoundingClientRect()
      const form = strip.parentElement!.querySelector(".terminal-xterm")!.getBoundingClientRect()
      expect(form.bottom).toBeLessThanOrEqual(host.bottom + 0.5)
      expect(overflow()).toBe(without)
      expect(overflow()).toBe(0)

      await offer().getByRole("button", { name: "Turn on" }).click()
      await expect.element(saying("Setting up voice input")).toBeVisible()
      expect(overflow()).toBe(0)

      await expect.element(saying("Voice input didn't install"), { timeout: 15_000 }).toBeVisible()
      expect(overflow()).toBe(0)
    })

    it("keeps its offer on the terminal whose mic is clicked in Grid, though the click selects it", async () => {
      await openWithoutVoice("/?demo=agents&voice=uninstalled")
      await chooseView("Grid")
      await terminal("Tests")
        .getByRole("button", { name: labelled("Set up voice input for ", "Tests") })
        .click()

      const inTests = terminal("Tests")
        .getByRole("status")
        .filter({ hasText: "Talk to your agents" })
      await expect.element(inTests).toBeVisible()
      await wait(600)
      await expect.element(inTests).toBeVisible()
    })

    it("installs on Turn on, shows it in the strip, and does not start recording", async () => {
      await openWithoutVoice()
      await clickInto("Checkout implementation")
      await press(`${dictateKeys}${releaseKeys}`)

      await offer().getByRole("button", { name: "Turn on" }).click()

      await expect.element(saying("Setting up voice input")).toBeVisible()
      await expect.element(saying("Voice input is ready."), { timeout: 15_000 }).toBeVisible()
      await expect.element(saying("Voice input is ready.").getByText(/to talk\./)).toBeVisible()
      expect(microphone.live()).toBe(0)
    })

    it("turns on when the shortcut is pressed again while the offer shows", async () => {
      await openWithoutVoice()
      await clickInto("Checkout implementation")
      await press(`${dictateKeys}${releaseKeys}`)
      await expect.element(offer()).toBeVisible()

      await press(`${dictateKeys}${releaseKeys}`)

      await expect.element(saying("Setting up voice input")).toBeVisible()
      expect(microphone.live()).toBe(0)
    })

    it("frees the shortcut and hides the microphone on No thanks", async () => {
      await openWithoutVoice("/?demo=agents&voice=uninstalled")
      await terminalTab("Checkout implementation").click()
      const mic = terminal("Checkout implementation").getByRole("button", {
        name: labelled("Set up voice input for ", "Checkout implementation"),
      })
      await mic.click()
      await expect.element(offer()).toBeVisible()
      expect(microphone.live()).toBe(0)

      await offer().getByRole("button", { name: "No thanks" }).click()

      await expect.element(offer()).not.toBeInTheDocument()
      await expect.element(mic).not.toBeInTheDocument()
      // The chord is the terminal's: nothing handled it, so nothing was prevented.
      const prevented: boolean[] = []
      const note = (event: KeyboardEvent): void => {
        if (event.key.toLowerCase() === "m" && event.ctrlKey) prevented.push(event.defaultPrevented)
      }
      document.addEventListener("keydown", note)
      try {
        await clickInto("Checkout implementation")
        await press(`${dictateKeys}${releaseKeys}`)
      } finally {
        document.removeEventListener("keydown", note)
      }
      expect(prevented).toEqual([false])
      await expect.element(offer()).not.toBeInTheDocument()
      expect(microphone.live()).toBe(0)
      // Addons still offers it.
      await pressShortcut("preferences")
      await preferencesDialog().getByRole("tab", { name: "Addons" }).click()
      await expect
        .element(
          preferencesDialog()
            .getByRole("region", { name: "Voice input" })
            .getByRole("button", { name: "Install" }),
        )
        .toBeVisible()
    })

    it("brings the microphone and the shortcut back when installed from Addons", async () => {
      await openWithoutVoice("/?demo=agents&voice=uninstalled")
      await terminalTab("Checkout implementation").click()
      const offered = terminal("Checkout implementation").getByRole("button", {
        name: labelled("Set up voice input for ", "Checkout implementation"),
      })
      await offered.click()
      await offer().getByRole("button", { name: "No thanks" }).click()
      await expect.element(offered).not.toBeInTheDocument()

      // Off until it is installed: the install is what turns it on again.
      await pressShortcut("preferences")
      await preferencesDialog().getByRole("tab", { name: "Addons" }).click()
      const card = preferencesDialog().getByRole("region", { name: "Voice input" })
      const enabled = card.getByRole("switch", { name: "Enabled" })
      await expect.element(enabled).toHaveAttribute("aria-checked", "false")
      await expect.element(enabled).toBeDisabled()
      await card.getByRole("button", { name: "Install" }).click()
      // The demo's install takes a few seconds, its three steps together.
      await expect.element(enabled, { timeout: 10_000 }).toHaveAttribute("aria-checked", "true")
      await press("{Escape}")

      await expect
        .element(
          terminal("Checkout implementation").getByRole("button", {
            name: labelled("Dictate into ", "Checkout implementation"),
          }),
        )
        .toBeVisible()
    })
  })

  context("when voice input is installed", () => {
    it("records while the shortcut is held and pastes the transcript into the terminal without sending it", async () => {
      await openWorkspace()
      await clickInto("Checkout implementation")

      await press(dictateKeys)
      await expect.element(saying("Release to send")).toBeVisible()
      // Speech captured, rather than time since the shortcut or microphone permission.
      await expect.poll(microphone.seconds).toBeGreaterThanOrEqual(0.5)
      expect(microphone.live()).toBe(1)

      // Modifiers may come up before the letter; the letter ends the hold.
      await press("{/Control}{/Shift}")
      await expect.element(saying("Listening")).toBeVisible()
      await press("{/M}")

      // "Transcribing" shows only as long as the demo takes, too briefly to wait for.
      await saidWhile(microphone, async () => {
        await expect
          .poll(() => draftOf("Checkout implementation"), { timeout: 15_000 })
          .toBe("Add a retry to the checkout request and run the tests.")
      })
      expect(microphone.live()).toBe(0)
    })

    it("keeps recording after a quick tap until the next press", async () => {
      await openWorkspace()
      await clickInto("Checkout implementation")

      tapDictation()
      await expect.element(saying("Esc discard")).toBeVisible()
      await expect.poll(microphone.seconds).toBeGreaterThanOrEqual(0.5)
      expect(microphone.live()).toBe(1)

      await press(`${dictateKeys}${releaseKeys}`)
      // "Transcribing" shows only as long as the demo takes, too briefly to wait for.
      await saidWhile(microphone, async () => {
        await expect
          .poll(() => draftOf("Checkout implementation"), { timeout: 15_000 })
          .toBe("Add a retry to the checkout request and run the tests.")
      })
    })

    it("shows its strip over a terminal's chat, not under it", async () => {
      localStorage.setItem("novadeck.preferences", JSON.stringify({ chatView: true }))
      await openWorkspace("/?demo=agents&channel=experimental")
      await skipWelcome()
      await terminalTab("Checkout implementation").click()
      const chat = terminal("Checkout implementation").getByRole("region", {
        name: "Checkout implementation chat",
      })
      await expect.element(chat).toBeVisible()

      await press(dictateKeys)
      const strip = saying("Release to send")
      await expect.element(strip).toBeVisible()
      // Stacked above the chat pane, which shares its layer over the terminal's content.
      const pane = terminal("Checkout implementation")
        .element()
        .querySelector("[data-workspace-chat]")!
      expect(layer(strip.element())).toBeGreaterThan(layer(pane))
      await press(releaseKeys)
    })

    it("drops the recording on Escape and releases the microphone", async () => {
      await openWorkspace()
      await clickInto("Checkout implementation")

      await press(dictateKeys)
      await wait(500)
      expect(microphone.live()).toBe(1)
      await press("{Escape}")
      await press(releaseKeys)

      await expect.poll(() => saying(/Listening|Transcribing/).elements().length).toBe(0)
      expect(microphone.live()).toBe(0)
      await expect.poll(() => draftOf("Checkout implementation")).toBe("")
    })
  })
})
