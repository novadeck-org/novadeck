import { describe, expect, it } from "vitest"

import type { ChatDialogOption, ChatRequest } from "../conversation"
import {
  needsWords,
  noExtras,
  optionExtras,
  saysYes,
  setsStanding,
  type OptionRole,
} from "./extras"

const option = (
  id: string,
  label: string,
  text: ChatDialogOption["text"] = null,
): ChatDialogOption => ({ id, label, text })

// Each option's role, by its label.
const roles = (
  kind: ChatRequest["kind"],
  options: readonly ChatDialogOption[],
): Record<string, OptionRole> =>
  Object.fromEntries(
    optionExtras(kind, options).map((extras, at) => [options[at]!.label, extras.role]),
  )

// Each harness's own dialogs, as its adapter reads them (`harnesses/*/src/*-dialog.ts` and
// their tests): every option has the role it says.
describe("A harness's permission and plan options", () => {
  describe("in Claude Code", () => {
    it("reads a command's or a fetch's permission", () => {
      expect(
        roles("permission", [
          option("1", "Yes"),
          option("2", "Yes, and don't ask again for example.com"),
          option("3", "No, and tell Claude what to do differently (esc)", "prompt"),
        ]),
      ).toEqual({
        Yes: "yes",
        "Yes, and don't ask again for example.com": "standing",
        "No, and tell Claude what to do differently (esc)": "words",
      })
    })

    it("reads its plain No beside the copy that takes words", () => {
      expect(
        roles("permission", [
          option("1", "Yes"),
          option("2", "Yes, and allow access to /tmp and touch approved.txt commands"),
          option("3", "No"),
          option("tell", "No, and tell Claude what to do", "prompt"),
        ]),
      ).toEqual({
        Yes: "yes",
        "Yes, and allow access to /tmp and touch approved.txt commands": "standing",
        No: "no",
        "No, and tell Claude what to do": "words",
      })
    })

    it("reads the yeses that last a session or a project as standing", () => {
      expect(
        roles("permission", [
          option("1", "Yes"),
          option(
            "2",
            "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)",
          ),
          option("3", "Yes, and always allow access to /repo/project from this project"),
          option("4", "Yes, allow reading from /repo/outside during this session"),
          option("5", "No"),
        ]),
      ).toEqual({
        Yes: "yes",
        "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)":
          "standing",
        "Yes, and always allow access to /repo/project from this project": "standing",
        "Yes, allow reading from /repo/outside during this session": "standing",
        No: "no",
      })
    })

    it("reads Ready to code?, arming auto-accept and saying what it lets Claude do", () => {
      const options = [
        option("1", "Yes, auto-accept edits"),
        option("2", "Yes, manually approve edits"),
        option("3", "Tell Claude what to change", "field"),
      ]
      expect(optionExtras("plan", options)).toEqual([
        { role: "standing", lines: null, effect: "It edits without asking.", hard: true },
        { role: "yes", lines: null, effect: null, hard: false },
        { role: "words", lines: null, effect: null, hard: false },
      ])
      expect(needsWords(options[2]!)).toBe(true)
    })

    it("reads Exit plan mode? as a plain yes: asking each time grants nothing", () => {
      expect(
        roles("plan", [
          option("1", "Yes, and switch to default (ask each time) for this session"),
          option("2", "No"),
        ]),
      ).toEqual({
        "Yes, and switch to default (ask each time) for this session": "yes",
        No: "no",
      })
    })

    it("arms accept edits in its newer words, as it does auto-accept", () => {
      const [extras] = optionExtras("plan", [
        option(
          "1",
          "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session",
        ),
      ])
      expect(extras).toEqual({
        role: "standing",
        lines: null,
        effect: "It edits without asking.",
        hard: true,
      })
    })

    it("arms bypass permissions and auto mode, saying what each lets Claude do", () => {
      const options = [
        option("1", "Yes, and bypass permissions"),
        option("2", "Yes, and use auto mode"),
        option("3", "Yes, clear context and auto-accept edits"),
        option("4", "Yes, and manually approve edits"),
        option("5", "No, keep planning", "prompt"),
      ]
      expect(
        optionExtras("plan", options).map(({ role, effect, hard }) => [role, effect, hard]),
      ).toEqual([
        ["standing", "It edits and runs commands without asking.", true],
        ["standing", "It acts without asking.", true],
        ["standing", "It edits without asking.", true],
        ["yes", null, false],
        ["words", null, false],
      ])
    })
  })

  describe("in Codex", () => {
    it("reads a command's permission, its scope in a line of its own", () => {
      const options = [
        option("1", "Yes, proceed"),
        option("2", "Yes, and don't ask again for commands that start with `pnpm add`"),
        option("3", "Yes, and don't ask again for this command in this session"),
        option("4", "Yes, and allow these permissions for this session"),
        option("5", "No, continue without running it"),
        option("6", "No, and tell Codex what to do differently", "prompt"),
      ]
      const extras = optionExtras("permission", options)
      expect(extras.map(({ role }) => role)).toEqual([
        "yes",
        "standing",
        "standing",
        "standing",
        "no",
        "words",
      ])
      expect(extras[1]!.lines).toEqual({
        head: "Yes, and don't ask again",
        scope: "for commands that start with `pnpm add`",
      })
      expect(extras[3]!.lines).toBeNull()
      // A permission's standing yes is no plan's: nothing to arm, nothing more to say.
      expect(extras.some(({ hard, effect }) => hard || effect !== null)).toBe(false)
    })

    it("reads a patch's permission", () => {
      expect(
        roles("permission", [
          option("1", "Yes, proceed"),
          option("2", "Yes, and don't ask again for these files"),
          option("3", "No, and tell Codex what to do differently", "prompt"),
        ]),
      ).toEqual({
        "Yes, proceed": "yes",
        "Yes, and don't ask again for these files": "standing",
        "No, and tell Codex what to do differently": "words",
      })
    })

    it("reads a request for permissions", () => {
      expect(
        roles("permission", [
          option("1", "Yes, grant these permissions for this turn"),
          option("2", "Yes, grant for this turn with strict auto review"),
          option("3", "Yes, grant these permissions for this session"),
          option("4", "No, continue without permissions"),
        ]),
      ).toEqual({
        "Yes, grant these permissions for this turn": "yes",
        "Yes, grant for this turn with strict auto review": "other",
        "Yes, grant these permissions for this session": "standing",
        "No, continue without permissions": "no",
      })
    })

    it("reads an MCP tool's, whose Always allow is standing and whose Cancel says no", () => {
      expect(
        roles("permission", [
          option("1", "Allow"),
          option("2", "Allow for this session"),
          option("3", "Always allow"),
          option("4", "Cancel"),
        ]),
      ).toEqual({
        Allow: "yes",
        "Allow for this session": "standing",
        "Always allow": "standing",
        Cancel: "no",
      })
    })

    it("reads a plan, whose fresh-thread yes is no plain one", () => {
      expect(
        roles("plan", [
          option("1", "Yes, implement this plan"),
          option("2", "Yes, clear context and implement"),
          option("3", "No, stay in Plan mode", "prompt"),
        ]),
      ).toEqual({
        "Yes, implement this plan": "yes",
        "Yes, clear context and implement": "other",
        "No, stay in Plan mode": "words",
      })
    })
  })

  describe("in Antigravity", () => {
    it("reads a command's permission", () => {
      expect(
        roles("permission", [
          option("1", "Yes, run command"),
          option(
            "2",
            "Yes, and always allow in this conversation for commands that start with 'echo'",
          ),
          option(
            "3",
            "Yes, and always allow for commands that start with 'echo' (Persist to settings.json)",
          ),
          option("4", "No, cancel", "prompt"),
        ]),
      ).toEqual({
        "Yes, run command": "yes",
        "Yes, and always allow in this conversation for commands that start with 'echo'":
          "standing",
        "Yes, and always allow for commands that start with 'echo' (Persist to settings.json)":
          "standing",
        "No, cancel": "words",
      })
    })

    it("reads a change to a file, and a new one", () => {
      expect(
        roles("permission", [
          option("1", "Yes, accept this change"),
          option("2", "No, reject this change", "prompt"),
        ]),
      ).toEqual({ "Yes, accept this change": "yes", "No, reject this change": "words" })
      expect(
        roles("permission", [
          option("1", "Yes, allow creation"),
          option("2", "No, deny creation", "prompt"),
        ]),
      ).toEqual({ "Yes, allow creation": "yes", "No, deny creation": "words" })
    })

    it("reads a plan's review", () => {
      expect(
        roles("plan", [
          option("approve", "Approve"),
          option("reject", "Reject"),
          option("feedback", "Tell it what to change", "field"),
        ]),
      ).toEqual({ Approve: "yes", Reject: "no", "Tell it what to change": "words" })
    })
  })
})

describe("An option's extras", () => {
  it("are none for wording no rule knows", () => {
    expect(optionExtras("permission", [option("a", "Continue"), option("b", "Stop")])).toEqual([
      noExtras,
      noExtras,
    ])
    expect(optionExtras("plan", [])).toEqual([])
  })

  it("never make a no or another yes the plain yes", () => {
    expect(roles("permission", [option("a", "Yes, always"), option("b", "No")])).toEqual({
      "Yes, always": "standing",
      No: "no",
    })
  })

  it("give the plain yes to a bare one before one a harness words so", () => {
    expect(roles("permission", [option("1", "Yes, proceed"), option("2", "Yes")])).toEqual({
      "Yes, proceed": "other",
      Yes: "yes",
    })
  })

  it.each([
    "Yes, auto mode",
    "Yes, permanently",
    "Yes, for the whole project",
    "Yes, allow this tool from now on",
    "Yes, but skip the sandbox",
    "Yes, bypass permissions",
    "Yes, clear context and manually approve edits",
    "Yes (all)",
    "Yes (a)",
  ])("never read %s as the plain yes", (label) => {
    expect(optionExtras("permission", [option("a", label)])[0]!.role).not.toBe("yes")
  })

  it.each([
    "Yes",
    "Allow",
    "Approve",
    "Allow once",
    "Yes.",
    "Yes (y)",
    "Yes, proceed",
    "Yes, proceed (y)",
    "Yes, manually approve edits",
  ])("read %s as the plain yes", (label) => {
    expect(optionExtras("permission", [option("a", label)])[0]!.role).toBe("yes")
  })

  it("read a no past the key hint its harness prints after it", () => {
    expect(roles("permission", [option("1", "Yes"), option("2", "No (esc)")])).toEqual({
      Yes: "yes",
      "No (esc)": "no",
    })
  })

  it("take no words back from an option that can't carry them", () => {
    const back = option("2", "Tell Claude what to change")
    expect(optionExtras("plan", [option("1", "Yes"), back])[1]).toEqual(noExtras)
    expect(needsWords(back)).toBe(true)
  })

  it("need words only where the option says no only with them", () => {
    expect(needsWords(option("3", "Tell Claude Code what to change", "field"))).toBe(true)
    expect(needsWords(option("3", "No, and tell Claude what to do differently", "prompt"))).toBe(
      false,
    )
  })

  it("keep a standing yes's scope in its own words, and one line where it has none", () => {
    expect(
      optionExtras("permission", [option("1", "Yes, and don't ask again for these files")])[0]!
        .lines,
    ).toEqual({ head: "Yes, and don't ask again", scope: "for these files" })
    expect(
      optionExtras("permission", [option("1", "Yes, allow all edits during this session")])[0]!
        .lines,
    ).toBeNull()
  })

  it("read standing only on a yes", () => {
    expect(setsStanding(option("1", "Yes, and don't ask again"))).toBe(true)
    expect(setsStanding(option("1", "No, and don't ask again"))).toBe(false)
    expect(saysYes(option("1", "Always allow"))).toBe(true)
    expect(saysYes(option("1", "Cancel"))).toBe(false)
  })
})
