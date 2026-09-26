import { expect } from "vitest"
import { page, type Locator } from "vitest/browser"

import { isMac, press } from "./workspace"

// Vocabulary for keyboard, search, switcher, and Preferences specs.

type Chord = { label: string; keys: string }

const command = (key: string, label: string): Chord =>
  isMac()
    ? { label: `Cmd+${label}`, keys: `{Meta>}${key}{/Meta}` }
    : { label: `Ctrl+Shift+${label}`, keys: `{Control>}{Shift>}${key}{/Shift}{/Control}` }

const commandShift = (key: string): Chord => {
  const modifier = isMac() ? "Meta" : "Control"
  return {
    label: `${isMac() ? "Cmd" : "Ctrl"}+Shift+${key}`,
    keys: `{${modifier}>}{Shift>}${key}{/Shift}{/${modifier}}`,
  }
}

/** Modifier shortcuts from the README table, for the platform the browser reports. */
export const shortcut = {
  find: (): Chord => command(isMac() ? "k" : "K", "K"),
  focus: (): Chord => command("{Enter}", "Enter"),
  newTerminal: (): Chord => command(isMac() ? "t" : "T", "T"),
  terminals: (): Chord => commandShift("1"),
  sessions: (): Chord => commandShift("2"),
  preferences: (): Chord =>
    isMac()
      ? { label: "Cmd+,", keys: "{Meta>},{/Meta}" }
      : { label: "Ctrl+,", keys: "{Control>},{/Control}" },
}

/** Presses a modifier shortcut, e.g. `pressShortcut("find")`. */
export const pressShortcut = (name: keyof typeof shortcut): Promise<void> =>
  press(shortcut[name]().keys)

/** Waits until keyboard focus has moved into a dialog, as a person sees before typing. */
export const expectFocusWithin = async (dialog: Locator): Promise<void> => {
  await expect.element(dialog).toBeVisible()
  await expect.poll(() => dialog.element().contains(document.activeElement)).toBe(true)
}

/** The region holding the current Focus, Grid, or Canvas view. */
export const viewRegion = (name: "focus" | "grid" | "canvas"): Locator =>
  page.getByRole("region", { name: `${name} view` })

export const findDialog = (): Locator => page.getByRole("dialog", { name: "Find a terminal" })

export const searchField = (): Locator =>
  findDialog().getByRole("combobox", { name: "Search terminals" })

/** A search result, matched by the terminal name it starts with. */
export const searchResult = (name: string): Locator =>
  findDialog().getByRole("option", { name: new RegExp(`^${name} `) })

/** Waits until search is ready for typing: its field focused and its results listed. */
export const expectSearchReady = async (): Promise<void> => {
  await expect.element(searchField()).toHaveFocus()
  await expect.element(findDialog().getByRole("option").first()).toBeVisible()
}

export const recentSwitcher = (): Locator => page.getByRole("dialog", { name: "Terminal switcher" })

export const recentOption = (name: string): Locator =>
  recentSwitcher().getByRole("option", { name, exact: true })

export const preferencesDialog = (): Locator => page.getByRole("dialog", { name: "Preferences" })

export const newTerminalName = "Terminal 07"

/** The Terminals sidebar heading, which counts the open terminals. */
export const terminalCount = (count: number): Locator =>
  page.getByRole("heading", { name: `Terminals ${count}`, exact: true })
