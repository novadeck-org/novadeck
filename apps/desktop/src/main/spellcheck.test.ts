import { describe, expect, it } from "../test"
import { keepSpellcheckOffline } from "./spellcheck"

// The languages each session created is given, on the platform asked for.
const sessions = (platform: NodeJS.Platform) => {
  type Listener = (session: { setSpellCheckerLanguages(languages: string[]): void }) => void
  const listeners: Listener[] = []
  keepSpellcheckOffline({ on: (_event, listener) => listeners.push(listener) }, platform)
  const given: string[][] = []
  for (const created of [...listeners, ...listeners])
    created({ setSpellCheckerLanguages: (languages) => void given.push(languages) })
  return given
}

describe("spellcheck", () => {
  it("gives every session on Linux no language, so no dictionary is downloaded", () => {
    expect(sessions("linux")).toEqual([[], []])
  })

  it("leaves macOS and Windows to the system's spellchecker", () => {
    expect(sessions("darwin")).toEqual([])
    expect(sessions("win32")).toEqual([])
  })
})
