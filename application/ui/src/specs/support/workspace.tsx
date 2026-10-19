import { StrictMode } from "react"
import { expect } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { page, userEvent, type Locator } from "vitest/browser"

import { App } from "../../app/App"
import { createSpecBackend } from "./backend"

// User-level vocabulary for behaviour specs. Specs describe what a person sees and
// does; only this module knows how that maps to accessible roles and names, so a
// reworked implementation that keeps the same UI needs changes here at most.
//
// Each spec file runs in its own page, but tests within a file share loaded modules:
// opening or reloading the workspace mounts a new <App />, it does not re-run module
// code. Keep workspace state owned by the App instance (for example a store created
// in a provider) so every test and every "reload" starts from the sample workspace.

const nextFrame = (): Promise<number> => new Promise(requestAnimationFrame)

/**
 * Opens the app, optionally at a deep link such as `/projects/storefront/sessions/initial/grid`,
 * and `embedded` as another page frames it.
 */
export const openWorkspace = async (
  route?: string,
  { embedded = false }: { readonly embedded?: boolean } = {},
): Promise<void> => {
  // A same-page history entry below the app keeps an extra Back inside the test page.
  window.history.replaceState(null, "", "/")
  window.history.pushState(null, "", route === undefined ? "/" : `/#${route}`)
  await render(
    <StrictMode>
      <App createBackend={createSpecBackend} embedded={embedded} />
    </StrictMode>,
  )
  // A link may open with a modal dialog, which hides the rest of the app.
  await expect.element(viewSwitcher().or(page.getByRole("dialog"))).toBeVisible()
  await layoutSettled()
}

/**
 * How long a wait for `frames` rendered frames may take: on a loaded runner a frame has
 * taken the better part of a second, so a count of frames gets a second each on top of
 * the usual wait, rather than the usual wait alone.
 */
export const stillFor = (frames: number): { readonly timeout: number } => ({
  timeout: 5000 + frames * 1000,
})

/**
 * Waits until the current view has been laid out and stopped moving. Panels size
 * themselves after the first paint, so gestures aimed at a point wait for this.
 */
export const layoutSettled = async (): Promise<void> => {
  await expect
    .element(page.getByRole("status", { name: "Loading workspace" }))
    .not.toBeInTheDocument()
  const current = page.getByRole("region", {
    name: /^(focus|grid|canvas) view$/,
    includeHidden: true,
  })
  const measure = (): string => {
    const found = current.elements()
    if (found.length !== 1) return "missing"
    const box = found[0]!.getBoundingClientRect()
    return box.width < 100 ? "unsized" : `${box.left},${box.top},${box.width},${box.height}`
  }
  // Counted in looks, and timed only once a frame is drawn: a file's first spec mounts the
  // demo's terminals cold, which on a loaded runner held back frames for longer than a
  // poll's 5 s timeout (reproduced at 30x CPU throttling), and that timeout failed a view
  // which settled on the next frame. Each look waits for a frame, 50 ms apart as the
  // poll's were, which specs that read a terminal's rows right after opening count on.
  const lookLimit = 75
  const timeLimit = 20_000
  const start = performance.now()
  let previous = ""
  let changes = 0
  let slowest = 0
  for (let looks = 1; ; looks += 1) {
    const asked = performance.now()
    // eslint-disable-next-line no-await-in-loop -- One look after another.
    await nextFrame()
    slowest = Math.max(slowest, performance.now() - asked)
    const next = measure()
    if (next !== "unsized" && next !== "missing" && next === previous) return
    if (previous !== "" && next !== previous) changes += 1
    previous = next
    if (looks >= lookLimit || performance.now() - start >= timeLimit)
      throw new Error(
        `the view never settled in ${looks} looks: it moved ${changes} times, the slowest frame took ${Math.round(slowest)} ms, and it was last ${next}`,
      )
    // eslint-disable-next-line no-await-in-loop -- As above.
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * Confirms that something does not happen: the element stays absent, or `shown` stays
 * false, for several rendered frames, so a reaction the app defers by a frame or two still
 * fails the check, and for at least `ms` milliseconds, for one it defers by a timer.
 */
export const expectStaysAbsent = async (
  what: Locator | { readonly shown: () => boolean; readonly name: string },
  { frames = 10, ms = 0 }: { readonly frames?: number; readonly ms?: number } = {},
): Promise<void> => {
  const [shown, name] =
    "shown" in what ? [what.shown, what.name] : [() => what.query() !== null, what.selector]
  let absent = 0
  let appeared = false
  const since = performance.now()
  await expect
    .poll(
      async () => {
        await nextFrame()
        appeared ||= shown()
        absent += 1
        return appeared || (absent >= frames && performance.now() - since >= ms)
      },
      { message: `${name} appeared`, timeout: ms + stillFor(frames).timeout },
    )
    .toBe(true)
  expect(appeared, `${name} appeared`).toBe(false)
}

/**
 * Notes how `read` sees `target` each time its `attribute` changes, from now on, and gives
 * back the notes when asked, which stops the noting: a state that passes quicker than a
 * check can poll for it, such as a change on its way, is still there to check after.
 */
export const recordChanges = <T,>(
  target: Locator,
  attribute: string,
  read: (element: Element) => T,
): (() => T[]) => {
  const element = target.element()
  const notes: T[] = []
  const observer = new MutationObserver(() => notes.push(read(element)))
  observer.observe(element, { attributes: true, attributeFilter: [attribute] })
  return () => {
    observer.disconnect()
    return notes
  }
}

/** Reloads the app at its current address: in-memory work starts over, stored preferences stay. */
export const reloadWorkspace = async (): Promise<void> => {
  const route = window.location.hash.replace(/^#/, "")
  await cleanup()
  await openWorkspace(route || undefined)
}

export const viewSwitcher = (): Locator =>
  page.getByRole("radiogroup", { name: "Workspace layout" })

export const view = (name: "Focus" | "Grid" | "Canvas"): Locator =>
  viewSwitcher().getByRole("radio", { name })

/** Clicks a view choice the way a person does: on its visible label. */
export const chooseView = async (name: "Focus" | "Grid" | "Canvas"): Promise<void> => {
  await viewSwitcher().getByText(name, { exact: true }).click()
  await expect.element(view(name)).toBeChecked()
  await layoutSettled()
}

export const sidebar = (): Locator => page.getByRole("complementary")

export const sidebarPanel = (name: "Terminals" | "Sessions" | "Notifications" | "Inbox"): Locator =>
  page
    .getByRole("radiogroup", { name: "Sidebar actions" })
    // The bell and the Inbox add how many wait to their names, e.g. "Inbox, 3 waiting".
    .getByRole("radio", {
      name: name === "Notifications" || name === "Inbox" ? new RegExp(`^${name}(,|$)`) : name,
    })

/** The Notifications sidebar's rows, one for each terminal that asks for the person. */
export const notifications = (): Locator =>
  page.getByRole("list", { name: "Notifications" }).getByRole("listitem")

/** The notification about the terminal in a project, e.g. `notification("docs-site")`. */
export const notification = (project: string): Locator =>
  notifications().filter({ hasText: project })

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A terminal's name from an accessible name that carries its `, @handle` after it. */
export const nameOf = (label: string): string => label.replace(/, @[a-z0-9]+(?= |$)/, "")

/**
 * An accessible name made of `before`, a terminal's name and `after`, as the name of a
 * control reads with or without the `, @handle` that follows the terminal's name.
 */
export const labelled = (before: string, name: string, after = ""): RegExp =>
  new RegExp(`^${literal(before)}${literal(name)}(, @[a-z0-9]+)?${literal(after)}$`)

/** A terminal as shown in the active Focus, Grid, or Canvas view. */
export const terminal = (name: string): Locator =>
  page.getByRole("region", { name: labelled("", name, " terminal") })

/** A terminal's entry in the Terminals sidebar. */
export const terminalTab = (name: string): Locator =>
  page.getByRole("button", { name: labelled("Select ", name) })

/**
 * Puts keyboard focus on a terminal's sidebar tab, as Tab or a screen reader would. A mouse
 * click on a tab sends keyboard focus into the terminal, so this waits for that to settle
 * and then moves focus back onto the tab.
 */
export const focusTab = async (name: string): Promise<void> => {
  await terminalTab(name).click()
  await expect.element(commandInput(name)).toHaveFocus()
  terminalTab(name).element().focus()
  await expect.element(terminalTab(name)).toHaveFocus()
}

/** Puts keyboard focus on the checked view choice, as Tab does; a mouse click sends it to the terminal. */
export const focusViewChoice = async (): Promise<void> => {
  const choice = viewSwitcher()
    .getByRole("radio")
    .elements()
    .find((radio) => (radio as HTMLInputElement).checked)!
  ;(choice as HTMLElement).focus()
  await expect.poll(() => document.activeElement === choice).toBe(true)
}

/** Puts keyboard focus on the empty stage, outside every terminal and without navigating. */
export const focusStage = async (): Promise<void> => {
  const stage = document.querySelector<HTMLElement>("[data-workspace-viewport]")!
  stage.focus()
  await expect.poll(() => document.activeElement === stage).toBe(true)
}

/** The footer's note while navigating. */
export const navigateChip = (): Locator =>
  page.getByRole("status").filter({ hasText: "Navigating" })

/** Presses Shift+Esc, the way a person starts navigating the workspace. */
export const enterNavigateMode = async (): Promise<void> => {
  // A mouse click hands keyboard focus to the terminal a frame later, which would end the mode.
  await nextFrame()
  await nextFrame()
  await press("{Shift>}{Escape}{/Shift}")
  await expect.element(navigateChip()).toBeVisible()
}

/** Enter or Esc while navigating: the chip goes and typing focus returns to `name`. */
export const expectTypingIn = async (name: string): Promise<void> => {
  await expect.element(commandInput(name)).toHaveFocus()
  await expect.element(navigateChip()).not.toBeInTheDocument()
}

/** A terminal's input, as both backends name it for assistive technology. */
export const commandInput = (name: string): Locator =>
  page.getByRole("textbox", { name: labelled("Input for ", name) })

// A terminal's text is read as a person reads it, whatever draws it: the demo's output
// as page text today, and a terminal emulator's rows (its accessibility tree, or the DOM
// renderer's rows) once the demo draws real terminal output.

// The rows an emulator shows, where a terminal is drawn as terminal output.
const emulatorRows = (region: Element): Element[] | undefined => {
  const rows =
    region.querySelector(".xterm-accessibility-tree") ?? region.querySelector(".xterm-rows")
  return rows ? [...rows.children] : undefined
}

// A terminal's lines: its emulator's rows, or its output's text as laid out.
const linesIn = (region: Element): string[] => {
  const rows = emulatorRows(region)
  if (rows) return rows.map((row) => (row.textContent ?? "").replace(/\u00a0/g, " ").trimEnd())
  const content = region.querySelector<HTMLElement>("[data-terminal-content]") ?? region
  return (content as HTMLElement).innerText.split("\n").map((line) => line.trimEnd())
}

/** What a terminal shows, line by line. */
export const terminalLines = (name: string): string[] => linesIn(terminal(name).element())

/** What a terminal shows, as one text. */
export const terminalText = (name: string): string => terminalLines(name).join("\n")

// The terminals in view.
const shownTerminals = (): Element[] =>
  [...document.querySelectorAll('section[aria-label$=" terminal"]')].filter((region) =>
    region.checkVisibility({ visibilityProperty: true }),
  )

/** Whether a terminal in view shows `line` as a whole line of it. */
export const terminalsShow = (line: string): boolean =>
  shownTerminals().some((region) => linesIn(region).some((each) => each.trim() === line))

/** What the terminals in view show, as one text. */
export const terminalsText = (): string =>
  shownTerminals()
    .map((region) => linesIn(region).join("\n"))
    .join("\n")

/** A line no terminal in view should show, for `expectStaysAbsent`. */
export const terminalLine = (line: string) => ({
  shown: () => terminalsShow(line),
  name: `a terminal's line "${line}"`,
})

/**
 * What is typed on a terminal's command line and not yet sent: the input's value, or, where
 * the line is drawn as output, the text after the prompt on the last line that has one.
 * Undefined while no prompt shows, so a check for an empty draft can't pass without one.
 */
export const draftOf = (name: string): string | undefined => {
  const input = commandInput(name).element()
  if (input instanceof HTMLInputElement) return input.value
  // Claude Code's prompt and a shell's start with ❯, Codex's with ›.
  const prompt = terminalLines(name).findLast((line) => /^\s*[❯›]/.test(line))
  return prompt?.trimStart().replace(/^[❯›]\s?/, "")
}

/**
 * Clicks where a person clicks to type in a terminal: its input, or, where an emulator draws
 * it, the screen at the cursor, where no link or overlay is in the way. Waits for either.
 */
export const clickInto = async (name: string): Promise<void> => {
  const input = commandInput(name)
  await expect.element(input).toBeInTheDocument()
  if (input.element() instanceof HTMLInputElement) return input.click()
  const screenOf = (): Element | null => terminal(name).element().querySelector(".xterm-screen")
  await expect.poll(screenOf).not.toBeNull()
  // The emulator keeps its input over the cursor. The click goes through the terminal's own
  // locator: one made from the screen would name it by the text it shows at that moment,
  // which no longer matches once the terminal draws again.
  // Playwright places the point from inside the terminal's border.
  const region = terminal(name)
  const at = input.element().getBoundingClientRect()
  const { left, top } = region.element().getBoundingClientRect()
  const { clientLeft, clientTop } = region.element()
  await region.click({
    position: {
      x: Math.max(1, at.left - left - clientLeft + 1),
      y: Math.max(1, at.top - top - clientTop + 1),
    },
  })
}

/** Types `text` on a terminal's command line, as a person does, after what is there. */
export const typeInto = async (name: string, text: string): Promise<void> => {
  const input = commandInput(name)
  await expect.element(input).toBeInTheDocument()
  input.element().focus()
  await expect.element(input).toHaveFocus()
  // `{` and `[` start a key's name in userEvent's syntax.
  await userEvent.keyboard(text.replace(/[{[]/g, (bracket) => bracket + bracket))
}

/**
 * Where a terminal draws `text`, for how it is styled: the element holding it, or the
 * emulator's DOM renderer row. An emulator drawing to a canvas styles no element with its
 * font (its accessibility tree uses the page's monospace), so there it throws rather than
 * read the wrong one.
 */
export const outputTextElement = (name: string, text: string): HTMLElement => {
  const region = terminal(name).element()
  const rows = region.querySelector(".xterm-rows")
  if (rows) {
    const row = [...rows.children].find((each) => each.textContent?.includes(text))
    if (!row) throw new Error(`${name} draws no row with "${text}"`)
    return row as HTMLElement
  }
  if (region.querySelector(".xterm"))
    throw new Error(`${name} draws to a canvas: no element has its font`)
  return terminal(name).getByText(text).element() as HTMLElement
}

/** Terminal names in sidebar order. */
export const terminalTabNames = (): string[] =>
  page
    .getByRole("button", { name: /^Select / })
    .elements()
    .map((element) => nameOf(element.getAttribute("aria-label")!.replace(/^Select /, "")))

export const expectSelected = async (name: string): Promise<void> => {
  await expect.element(terminalTab(name)).toHaveAttribute("aria-current", "true")
}

export const expectNothingSelected = async (): Promise<void> => {
  await expect
    .poll(() =>
      page
        .getByRole("button", { name: /^Select / })
        .elements()
        .filter((tab) => tab.getAttribute("aria-current") === "true"),
    )
    .toHaveLength(0)
}

/** Visible terminal counts such as `6 terminals`; hidden session entries use the same wording. */
export const visibleTerminalCounts = (): (string | null)[] =>
  page
    .getByText(/^\d+ terminals?$/)
    .elements()
    .filter((count) => count.checkVisibility({ visibilityProperty: true }))
    .map((count) => count.textContent)

/** Types keys through the real keyboard, e.g. `press("{Escape}")` or `press("{Control>}{Tab}{/Control}")`. */
export const press = (keys: string): Promise<void> => userEvent.keyboard(keys)

/** What `trigger`'s tooltip says, once the pointer has rested on it, as a person reads it. */
export const tooltipOf = async (trigger: Locator): Promise<string> => {
  await userEvent.hover(trigger)
  // The open tooltip is the trigger's own, never another still closing: the one its
  // description names, or, where something else describes it (a sortable handle), the
  // one its id pairs with.
  const shown = (): Element | null => {
    const element = trigger.element()
    const named = (element.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .find((each) => each?.matches('[data-scope="tooltip"][data-part="content"]'))
    const paired = element.id.endsWith(":trigger")
      ? document.getElementById(element.id.replace(/:trigger$/, ":content"))
      : null
    const open = named ?? paired
    return open?.getAttribute("data-state") === "open" ? open : null
  }
  await expect.poll(shown).not.toBeNull()
  return shown()!.textContent ?? ""
}

/** The platform modifier: Cmd on macOS, Ctrl elsewhere. Chromium on Linux/Windows uses Ctrl. */
export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * What a screen reader hears describe a terminal's tab, as aria-describedby resolves it,
 * less the instructions for reordering tabs every tab has; null when that's all.
 */
export const tabDescription = (name: string): string | null => {
  const tab = terminalTab(name).element()
  const ids = tab.getAttribute("aria-describedby")
  // Whatever aria-describedby names, a screen reader hears it instead of aria-description.
  if (!ids) return tab.getAttribute("aria-description")
  const parts = ids
    .split(/\s+/)
    // dnd-kit's own description, how to reorder the tab, is every tab's.
    .filter((id) => id && !id.startsWith("dnd-kit-description-"))
    .map((id) => document.getElementById(id)?.textContent ?? "")
  return parts.length ? parts.join(" ") : null
}
