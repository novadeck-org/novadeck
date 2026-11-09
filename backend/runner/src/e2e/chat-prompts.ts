import type { TranscriptItem } from "@novadeck/protocol"

import type { DeckImage, DeckTerminal } from "./deck.js"
import { expect } from "./fixture.js"

// What the chat scenarios share: reading a harness's transcript as a client does, and giving
// it a prompt with a receipt checked.

/** The root transcript's text items of `role`, as `agents.transcript` gives them. */
export const texts = async (
  terminal: DeckTerminal,
  role: TranscriptItem["role"],
): Promise<string[]> =>
  (await terminal.transcript())
    .filter((item) => item.role === role && item.kind === "text")
    .map((item) => item.text)

/** Waits until the transcript holds a `role` item whose text passes `fits`, and returns it. */
export const item = (
  terminal: DeckTerminal,
  role: TranscriptItem["role"],
  fits: (text: string) => boolean,
): Promise<string> =>
  terminal.poll(
    async () => {
      // A transcript the agent has not opened yet (or is changing) is NOT_FOUND: wait on.
      try {
        return (await texts(terminal, role)).find(fits)
      } catch (error) {
        if ((error as { code?: string }).code === "NOT_FOUND") return undefined
        throw error
      }
    },
    `its transcript to hold a ${role} item`,
    30_000,
  )

/** Text without its placeholders of images and runs of white space, as words are told apart. */
const unmarked = (text = ""): string =>
  text
    .replace(/\[Image #\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()

/**
 * Gives the agent a prompt as the chat does, and checks its receipt: followed, pending or
 * already settled once the Enter is out (`agents.detail`); then returns a wait for it to
 * settle, as the user item at its `item` that holds its words.
 */
export const prompted = async (
  terminal: DeckTerminal,
  text: string,
  images: readonly DeckImage[] = [],
  places?: readonly number[],
): Promise<() => Promise<void>> => {
  // Its first line names it in a failure: a long prompt's whole text would bury the message.
  const [label = ""] = text.split("\n")
  const receiptOf = async (ref: string) =>
    ((await terminal.detail()).prompts ?? []).find((prompt) => prompt.ref === ref)
  const { ref, tracked } = await terminal.prompt(text, images, places)
  expect(tracked, `${label}: followed`).toBe(true)
  expect((await receiptOf(ref))?.state, `${label}: its receipt once sent`).toMatch(
    /^(pending|settled)$/,
  )
  return async () => {
    const settled = await terminal.poll(
      async () => {
        const receipt = await receiptOf(ref)
        expect(receipt?.state, `${label}: never missing`).not.toMatch(/^(unrecorded|in-box)$/)
        return receipt?.state === "settled" ? receipt : undefined
      },
      `"${label}" to reach its agent's record`,
      30_000,
    )
    const items = await terminal.transcript()
    const at = items.find((each) => each.index === settled.item)
    expect(at?.role, `${label}: settled by`).toBe("user")
    // Images among the words are in the record as placeholders there: the words are what is told.
    expect(unmarked(at?.text), `${label}: settled by`).toContain(unmarked(label))
  }
}
