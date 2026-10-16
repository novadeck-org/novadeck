import type { DemoVoice } from "../voice"
import type { DemoActionGroup } from "./types"

// Presses Ctrl+Shift+M as a person would, which opens the offer in the selected terminal's
// strip while voice input is not installed, and, with the offer showing, turns it on; the
// window's keyboard routing takes it as it takes the keys themselves.
const pressChord = (): void => {
  const init = { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true, bubbles: true }
  window.dispatchEvent(new KeyboardEvent("keydown", init))
  window.dispatchEvent(new KeyboardEvent("keyup", init))
}

// The panel's Voice input group: voice input's setup, which lives in the dictation strip of
// the selected agent's terminal (or the overlay at the app's foot where none shows), and
// the mic once declined. The actions that set up an install press the chord for you: once
// for the offer, twice to turn it on.
export const voiceGroups = (voice: DemoVoice | undefined): readonly DemoActionGroup[] =>
  voice
    ? [
        {
          section: "App",
          title: "Voice input",
          actions: [
            {
              label: "Installed",
              hint: "On; the mic and Ctrl+Shift+M dictate; no offer",
              run: () => voice.show("installed"),
            },
            {
              label: "Not installed",
              hint: "The mic or Ctrl+Shift+M opens the offer in the terminal's strip; typing, another terminal or 15 s hides it, and the next press offers again",
              run: () => voice.show("uninstalled"),
            },
            {
              label: "Offer in the strip",
              hint: "Opens the offer: Talk to your agents, its size, No thanks and Turn on",
              run: () => {
                voice.show("uninstalled")
                pressChord()
              },
            },
            {
              label: "Software rendering",
              hint: "The offer quotes small's smaller size and Turn on installs small only",
              run: () => {
                voice.show("software-graphics")
                pressChord()
              },
            },
            {
              label: "Installing",
              hint: "The strip shows Setting up voice input at the model, half there, with Cancel",
              run: () => {
                voice.show("installing")
                pressChord()
                pressChord()
              },
            },
            {
              label: "Install, then ready",
              hint: "The strip follows the steps, then says Voice input is ready and how to talk, for a few seconds",
              run: () => {
                voice.show("install-and-finish")
                pressChord()
                pressChord()
              },
            },
            {
              label: "Install, turbo too slow",
              hint: "The strip follows turbo, then small's model and check, then says ready; turbo is gone",
              run: () => {
                voice.show("install-fallback")
                pressChord()
                pressChord()
              },
            },
            {
              label: "Cancelled at the check",
              hint: "Engine and model on disk, never checked: the offer says no size, and Addons shows Install with Uninstall",
              run: () => {
                voice.show("cancelled-at-check")
                pressChord()
              },
            },
            {
              label: "Install fails (network)",
              hint: "The strip shows the failure with Try again, not a decline",
              run: () => {
                voice.show("network-failure")
                pressChord()
                pressChord()
              },
            },
            {
              label: "Declined",
              hint: "No mic in agent terminals, and Ctrl+Shift+M reaches the terminal; Addons still offers it",
              run: () => voice.show("declined"),
            },
          ],
        },
      ]
    : []
