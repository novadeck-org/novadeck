import { registerPerson, storedPerson, type PersonItem } from "@novadeck/core/person"

// A mark that something was used once, kept under `key` in localStorage: a footer chip shows its
// word until then and is the icon alone from then on. It follows the person (core's person.ts),
// under its key without `novadeck.`: used once on any device is used. Storage may be
// unavailable (a private window, blocked site data): the mark then reads as unset and the word
// stays for the session.

const marks = new Map<string, PersonItem & { readonly save: (text: string | null) => void }>()

const markOf = (key: string) => {
  let mark = marks.get(key)
  if (!mark) {
    const stored = storedPerson(key.replace(/^novadeck\./, ""), key)
    // Only a use is kept or taken: a device that never used it gives nothing.
    mark = {
      ...stored,
      read: () => (stored.read() === "1" ? "1" : undefined),
      write: (text) => {
        if (text === "1") stored.write(text)
      },
    }
    marks.set(key, mark)
    registerPerson(mark)
  }
  return mark
}

export const readFirstUse = (key: string): boolean => markOf(key).read() === "1"

export const writeFirstUse = (key: string): void => markOf(key).save("1")
