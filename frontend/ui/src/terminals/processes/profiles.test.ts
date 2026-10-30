import { itemFixture, terminalFixture } from "@novadeck/core/testing"
import type { TerminalMetadata } from "@novadeck/core/types"
import { AntigravityIcon } from "@novadeck/toolkit/icons/AntigravityIcon"
import { ClaudeIcon } from "@novadeck/toolkit/icons/ClaudeIcon"
import { CodexIcon } from "@novadeck/toolkit/icons/CodexIcon"
import { BookText, FileCode2, FileText, Globe, Image, Terminal } from "lucide-react"

import { context, describe, expect, it } from "../../test"
import { terminalProfile, windowProfile } from "./profiles"

describe("a window undocked from a terminal's companion", () => {
  context("presents as what it shows", () => {
    it("gives the icon of each kind of item, a subagent's plan too", () => {
      const items = [
        itemFixture("plan", "01", {
          kind: "plan",
          name: "plan.md",
          plan: { agent: "Codex", role: "root", source: "file" },
        }),
        itemFixture("sub", "01", {
          kind: "plan",
          name: "old-migration.md",
          plan: { agent: "Codex", role: "subagent", source: "text" },
        }),
        itemFixture("notes", "01", { kind: "file", name: "notes.md" }),
        itemFixture("docs", "01", { kind: "file", name: "README.MARKDOWN" }),
        itemFixture("app", "01", { kind: "file", name: "App.tsx" }),
        itemFixture("hero", "01", { kind: "image", name: "hero.png" }),
        itemFixture("web", "01", { kind: "page", name: "localhost:5173", path: null }),
      ]
      expect(items.map((item) => windowProfile(item).icon)).toEqual([
        FileText,
        FileText,
        BookText,
        BookText,
        FileCode2,
        Image,
        Globe,
      ])
      expect(windowProfile(undefined).icon).toBe(FileText)
    })
  })
})

const terminal = (process: string, status: Partial<TerminalMetadata> = {}) =>
  ({
    ...terminalFixture(1, "~/project"),
    process,
    state: "running",
    ...status,
  }) as TerminalMetadata

describe("terminal profile", () => {
  context("while a program holds the foreground", () => {
    it("presents Claude Code, Codex and Antigravity with their own icons", () => {
      expect(terminalProfile(terminal("claude"))).toEqual({ icon: ClaudeIcon })
      expect(terminalProfile(terminal("codex"))).toEqual({ icon: CodexIcon })
      expect(terminalProfile(terminal("agy"))).toEqual({ icon: AntigravityIcon })
    })

    it("presents any other program as a plain terminal", () => {
      for (const process of ["vim", "node", "constructor"])
        expect(terminalProfile(terminal(process))).toEqual({ icon: Terminal })
    })
  })

  context("once the program no longer runs", () => {
    it("presents a plain terminal, whatever program was last seen", () => {
      const states: Partial<TerminalMetadata>[] = [
        { state: "idle" },
        { state: "starting" },
        { state: "failed", message: "Exited right after starting" },
        { state: "exited", exitCode: 1, signal: null },
      ]
      for (const status of states)
        expect(terminalProfile(terminal("claude", status))).toEqual({ icon: Terminal })
    })
  })
})
