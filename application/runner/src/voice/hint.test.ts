import { describe, expect, it } from "../test.js"
import { dictationHint, hintChars, hintFiles, hintModules, type HintFacts } from "./hint.js"

const none: HintFacts = { project: null, cwd: "", branch: null, folders: [], files: [] }

const facts = (some: Partial<HintFacts>): HintFacts => ({ ...none, ...some })

describe("the dictation hint", () => {
  it("names the project, its branch and folder, then the modules and files there", () => {
    expect(
      dictationHint(
        {
          project: "Novadeck",
          cwd: "/home/me/novadeck/application/runner",
          branch: "task/whisper-hints",
          folders: ["application/runner/src/voice", "application/protocol/src"],
          files: ["service.ts", "hint.ts"],
        },
        "en",
      ),
    ).toBe(
      "Working on Novadeck, on the whisper-hints branch, in the runner folder, with voice, " +
        "protocol, service.ts and hint.ts.",
    )
  })

  it("takes a monorepo's packages and modules from the folders written in, not its layout", () => {
    expect(
      dictationHint(
        facts({
          folders: [
            "packages/billing/src/invoices",
            "apps/web/src/components/checkout",
            "packages\\billing\\lib",
            ".github/workflows",
            "",
          ],
        }),
        "en",
      ),
    ).toBe("With billing, invoices, web, components and checkout.")
    const deep = dictationHint(
      facts({ folders: ["core/api/auth/oauth/google/tokens/cache"] }),
      "en",
    )
    expect(deep).toBe("With core, api, auth, oauth, google and tokens.")
    expect(deep.split(", ")).toHaveLength(hintModules - 1)
  })

  it("lists each name once, whatever its case, a file's without its extension too", () => {
    expect(
      dictationHint(
        facts({
          project: "Checkout",
          cwd: "/srv/checkout",
          branch: "feat/ledger",
          files: ["ledger.ts", "Ledger.ts", "refunds.ts", "refunds.ts"],
        }),
        "en",
      ),
    ).toBe("Working on Checkout, on the ledger branch, with refunds.ts.")
    expect(
      dictationHint(facts({ folders: ["voice/hint"], files: ["hint.ts", "Voice.ts"] }), "en"),
    ).toBe("With voice and hint.")
  })

  it("leaves out commits, ids, numbers, addresses, long names and folders every project has", () => {
    expect(
      dictationHint(
        facts({
          project: "Api",
          cwd: "/home/me/api/src",
          branch: "3f9a2c1",
          files: [
            "2026-10-10.log",
            "x",
            "123e4567-e89b-12d3-a456-426614174000.json",
            "me@example.com",
            `${"a".repeat(40)}.ts`,
            "routes.ts",
          ],
        }),
        "en",
      ),
    ).toBe("Working on Api, with routes.ts.")
    expect(dictationHint(facts({ project: "Api", branch: "main" }), "en")).toBe("Working on Api.")
    // Letters a to f alone make a word, not a commit.
    expect(dictationHint(facts({ branch: "fix/defaced" }), "en")).toBe("On the defaced branch.")
  })

  it("keeps to its caps on files and length, the first names kept", () => {
    const many = Array.from({ length: 20 }, (_, index) => `mod${index}.ts`)
    const capped = dictationHint(facts({ project: "Big", files: many }), "en")
    expect(capped).toContain(`and mod${hintFiles - 1}.ts.`)
    expect(capped).not.toContain(`mod${hintFiles}.ts`)
    const long = Array.from({ length: 20 }, (_, index) => `averyverylongmodulename${index}.ts`)
    const hint = dictationHint(facts({ project: "Big", files: long }), "en")
    expect(hint.length).toBeLessThanOrEqual(hintChars)
    expect(hint).toMatch(/^Working on Big, with averyverylongmodulename0\.ts, .* and \S+\.$/)
    const both = dictationHint(facts({ folders: ["billing"], files: long }), "en")
    expect(both).toMatch(/^With billing, averyverylongmodulename0\.ts, /)
    // However long the project's name, the hint is not, if without it.
    const named = facts({ project: "p".repeat(256), branch: "b".repeat(32), cwd: "c".repeat(32) })
    expect(dictationHint({ ...named, files: long }, "en").length).toBeLessThanOrEqual(hintChars)
    expect(dictationHint({ ...named, project: "p".repeat(64) }, "en")).toContain("p".repeat(64))
  })

  it("is nothing without anything to say, or only what there is", () => {
    expect(dictationHint(none, "en")).toBe("")
    expect(dictationHint(none, "pl")).toBe("")
    expect(dictationHint(facts({ project: " ", cwd: "/" }), "en")).toBe("")
    expect(dictationHint(facts({ cwd: "/srv/api" }), "en")).toBe("In the api folder.")
    expect(dictationHint(facts({ files: ["a.ts", "b.ts"] }), "en")).toBe("With a.ts and b.ts.")
    expect(dictationHint(facts({ project: "Home", cwd: "/home/me/" }), "en")).toBe(
      "Working on Home, in the me folder.",
    )
    expect(dictationHint(facts({ project: "novadeck", cwd: "C:\\work\\novadeck\\" }), "en")).toBe(
      "Working on novadeck.",
    )
  })

  it("has no English words for any other language, or one the engine tells", () => {
    const some = facts({
      project: "Kasa",
      cwd: "/srv/kasa/faktury",
      branch: "fix/vat-rates",
      files: ["vatRates.ts", "faktura.ts"],
    })
    expect(dictationHint(some, "pl")).toBe("Kasa, vat-rates, faktury: vatRates.ts, faktura.ts.")
    expect(dictationHint(some, "auto")).toBe(dictationHint(some, "pl"))
    expect(dictationHint(facts({ project: "Kasa" }), "de")).toBe("Kasa.")
    expect(dictationHint(facts({ files: ["a.ts"] }), "de")).toBe("a.ts.")
  })
})
