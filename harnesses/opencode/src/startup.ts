import type { PromptShown } from "@novadeck/harness-core/events"
import type { Harness } from "@novadeck/harness-core/harness"

/**
 * No screen of opencode holds it for the person before its prompt (probed 2026-11-22, 1.19.6,
 * fixtures/dialogs.probe.json `noProviders`, `refused401`, `noNetwork`): with no provider
 * configured at all it starts on the home screen all the same, its `opencode` provider's free
 * models selected (`Build · Big Pickle OpenCode`) and a tip, "Run /connect to add an AI provider",
 * under the box; with a provider that answers 401 it starts normally too, and the first prompt shows
 * the provider's error (`invalid x-api-key`) in the conversation, which its plugin's `session.error`
 * reports; with no network the same, `Proxy refused to open a tunnel`. It has no trust, onboarding,
 * hooks-review, update or sign-in screen, so none reads as held and none as signed out.
 */
export const heldScreen: NonNullable<Harness["heldScreen"]> = () => undefined

export const signedOut: NonNullable<Harness["signedOut"]> = () => false

/**
 * Whether the terminal title it sets says its prompt shows: `OpenCode` on its home screen and
 * `OC | <session title>` in a session (probed 2026-11-22, 1.19.6, titles of a run that started,
 * sent a prompt and went `/new`). It sets the first one as its screen is first drawn, with the
 * box's paint 52 ms behind it on an idle machine and the screen still blank at that title, so it
 * says the prompt is about to show, and nothing stands between: no screen of its own comes
 * before the box. It sets `OC | …` again as the session's title is made, a turn running or not,
 * and the box stays up through a turn, so every one of its titles is one with the prompt showing.
 */
export const title = (text: string, at: number): PromptShown | undefined =>
  text === "OpenCode" || text.startsWith("OC | ")
    ? { type: "prompt-shown", agent: "opencode", instance: null, startedAt: at }
    : undefined
