import { describe, expect, it } from "../test"
import { matchRows, rowsOf, type PreferenceRow } from "./preferences-search"

const row = (label: string, description = "", page = "Notifications"): PreferenceRow<string> => ({
  label,
  description,
  page,
  target: label,
})

describe("matching preferences", () => {
  const rows = [
    row("Ring the bell", "Novadeck rings when an agent needs you or finishes."),
    row("Sound", "Theme's bell"),
    row("Volume", "For the bell inside Novadeck."),
    row("Text size", "", "Terminal"),
  ]

  it("finds nothing for an empty query", () => {
    expect(matchRows("  ", rows)).toEqual([])
  })

  it("finds a setting by its name, its words or its page, every word of the query", () => {
    expect(matchRows("size", rows).map(({ label }) => label)).toEqual(["Text size"])
    expect(matchRows("terminal text", rows).map(({ label }) => label)).toEqual(["Text size"])
    expect(matchRows("bell volume", rows).map(({ label }) => label)).toEqual(["Volume"])
  })

  it("lists those named by the query before those it only describes", () => {
    expect(matchRows("bell", rows).map(({ label }) => label)).toEqual([
      "Ring the bell",
      "Sound",
      "Volume",
    ])
    expect(matchRows("sound", rows)[0]?.label).toBe("Sound")
  })

  it("lists a setting a page shows twice once", () => {
    expect(matchRows("sound", [...rows, row("Sound", "Theme's bell")])).toHaveLength(1)
  })
})

describe("the settings a page shows", () => {
  const pageOf = (html: string): HTMLElement => {
    const root = document.createElement("div")
    root.innerHTML = html
    return root
  }

  it("names each row by its first words, past its control and what describes it", () => {
    const root = pageOf(`
      <div role="tabpanel" id="tabs:r1:content-terminal">
        <div class="settings-row">
          <span><span id="ligatures-label">Ligatures</span>
          <span class="settings-description">Join pairs into one symbol.</span></span>
          <button role="switch">On</button>
        </div>
        <div class="settings-row"><button>Open logs folder</button></div>
      </div>`)

    expect(
      rowsOf(root, () => "Terminal").map(({ label, description, page }) => [
        label,
        description,
        page,
      ]),
    ).toEqual([["Ligatures", "Join pairs into one symbol.", "Terminal"]])
  })

  it("skips the pages it is told to, and those without a name", () => {
    const root = pageOf(`
      <div role="tabpanel" id="tabs:r1:content-experimental"><div class="settings-row">Agent avatars</div></div>
      <div role="tabpanel" id="tabs:r1:content-gone"><div class="settings-row">Old</div></div>`)

    expect(
      rowsOf(root, (id) => (id === "gone" ? undefined : "Experimental"), new Set(["experimental"])),
    ).toEqual([])
  })
})
