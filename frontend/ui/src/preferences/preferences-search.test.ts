import { describe, expect, it } from "../test"
import { matchRows, rowsOf, type PreferenceRow } from "./preferences-search"

const row = (
  label: string,
  description = "",
  page = "Notifications",
  section = "",
): PreferenceRow<string> => ({ label, description, page, section, target: label })

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

  it("finds a setting by its section, and tells apart two sections' rows of one name", () => {
    const addons = [
      row("Enabled", "", "Addons", "Voice input"),
      row("Enabled", "", "Addons", "Murmur"),
    ]
    expect(matchRows("voice", addons).map(({ section }) => section)).toEqual(["Voice input"])
    expect(matchRows("enabled", addons)).toHaveLength(2)
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

  it("names a row with no name of its own by its section, and skips a picture beside a choice", () => {
    const root = pageOf(`
      <div role="tabpanel" id="tabs:r1:content-addons">
        <section><header><h3>Voice input</h3></header>
          <div class="settings-row"><button>Install</button>
            <span class="settings-note">Downloads 140 MB once.</span></div>
          <div class="settings-row" data-search-skip><span>:5173</span></div>
        </section>
      </div>`)

    expect(
      rowsOf(root, () => "Addons").map(({ label, section, description }) => [
        label,
        section,
        description,
      ]),
    ).toEqual([["Voice input", "Voice input", "Downloads 140 MB once."]])
  })

  it("skips the pages without a name", () => {
    const root = pageOf(`
      <div role="tabpanel" id="tabs:r1:content-gone"><div class="settings-row">Old</div></div>`)

    expect(rowsOf(root, () => undefined)).toEqual([])
  })
})
