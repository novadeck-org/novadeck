import { writeChatOfferAnswered } from "@novadeck/core/agents/chat-offer"

import type { DemoLaunch } from "./debug-demo"
import type { DemoActionGroup } from "./types"

// The key the UI keeps the preferences under (`preferencesStorageKey` of the UI's
// preferences-storage.ts, which this package can't import).
const preferencesKey = "novadeck.preferences"

// Turns the saved chat view off, as it was before the person ever chose it, leaving every other
// saved preference as it is.
const turnChatViewOff = (): void => {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(preferencesKey) ?? "{}")
    const preferences = typeof saved === "object" && saved !== null ? saved : {}
    window.localStorage.setItem(preferencesKey, JSON.stringify({ ...preferences, chatView: false }))
  } catch {
    // Without storage the chat view was never saved on.
  }
}

// The panel's Agent Chat offer group, where the backend reads conversations (every demo but the
// plain ones): the one-time card for people who updated past the welcome dialog.
export const chatOfferGroups = (launch: DemoLaunch, reads: boolean): readonly DemoActionGroup[] =>
  reads
    ? [
        {
          section: "App",
          title: "Agent Chat offer",
          actions: [
            {
              label: "Offer Agent Chat",
              hint: "Turns Agent Chat off and forgets it was offered: a card, Agent Chat, with Turn on and No thanks, rises over the footer's right end while an agent's terminal is selected (select one if a shell is)",
              reboots: true,
              run: () => {
                turnChatViewOff()
                writeChatOfferAnswered(false)
                launch.rehearsals.rehearse({ reboot: true })
              },
            },
          ],
        },
      ]
    : []
