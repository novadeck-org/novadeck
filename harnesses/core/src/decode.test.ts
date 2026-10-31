import { maxTurnError } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

import {
  callId,
  commandFolder,
  errorText,
  firedFacts,
  maxPlan,
  planText,
  shortName,
  withMode,
  withRequestCwd,
} from "./decode.js"
import type { HarnessEvent } from "./events.js"

const base = { agent: "claude", sessionId: "s1", instance: "7", startedAt: 10 } as const
const started: HarnessEvent = { ...base, type: "turn-started", cause: "prompt" }
const asked: HarnessEvent = {
  ...base,
  type: "attention-requested",
  requestId: "r1",
  actor: null,
  toolName: "Bash",
  kind: "permission",
  subject: "ls",
  choices: [],
}
const bidi = String.fromCodePoint(0x202e)
const zeroWidth = String.fromCodePoint(0x200b)

describe("a failed turn's error", () => {
  it("keeps its lines, and drops escapes, controls and reordering marks", () => {
    expect(errorText(`\x1b[31mrate limited\x1b[0m\nretry\x00 at ${bidi}noon\t `)).toBe(
      "rate limited\nretry  at  noon",
    )
  })

  it("is cut to what the protocol takes", () => {
    const error = errorText("x".repeat(maxTurnError * 2 + 1))
    expect(error).toHaveLength(maxTurnError)
  })

  it("is nothing when nothing is left, or it isn't text", () => {
    expect(errorText(" \x1b[0m ")).toBeUndefined()
    expect(errorText(42)).toBeUndefined()
  })
})

describe("a short name a harness gives", () => {
  it("is taken trimmed", () => {
    expect(shortName("  opus  ", 20)).toBe("opus")
  })

  it("is refused blank, too long, or holding a control or invisible character", () => {
    expect(shortName("   ", 20)).toBeUndefined()
    expect(shortName("a".repeat(21), 20)).toBeUndefined()
    expect(shortName(`op${zeroWidth}us`, 20)).toBeUndefined()
    expect(shortName("op\nus", 20)).toBeUndefined()
    expect(shortName(7, 20)).toBeUndefined()
  })
})

describe("a hook's permission mode", () => {
  it("adds whether the root agent plans after its facts", () => {
    expect(withMode([started], { permission_mode: "plan" })).toEqual([
      started,
      { ...base, type: "mode-observed", planning: true },
    ])
    expect(withMode([started], { permission_mode: "default" })[1]).toMatchObject({
      planning: false,
    })
  })

  it("adds nothing for a subagent's hook, a hook with no mode, or no facts", () => {
    expect(withMode([started], { permission_mode: "plan", agent_id: "a1" })).toEqual([started])
    expect(withMode([started], {})).toEqual([started])
    expect(withMode([], { permission_mode: "plan" })).toEqual([])
  })
})

describe("a request's directory", () => {
  it("is the absolute one its hook named, where it has none", () => {
    expect(withRequestCwd([started, asked], { cwd: "/work" })).toEqual([
      started,
      { ...asked, cwd: "/work" },
    ])
  })

  it("is left as it is for a relative directory, or one it already has", () => {
    expect(withRequestCwd([asked], { cwd: "work" })).toEqual([asked])
    const own = { ...asked, cwd: "/own" }
    expect(withRequestCwd([own], { cwd: "/work" })).toEqual([own])
  })
})

describe("the folder a command runs in", () => {
  it("is its tool's own working directory, resolved against the hook's", () => {
    expect(commandFolder("ls", "/w", "/x/y")).toBe("/x/y")
    expect(commandFolder("cd /a && ls", "/w", "sub")).toBe("/w/sub")
  })

  it("is where a leading cd moves it, bare or quoted, absolute or relative", () => {
    expect(commandFolder("cd /home/me/tasks/b/repo && pnpm test", "/w")).toBe(
      "/home/me/tasks/b/repo",
    )
    expect(commandFolder("cd ../b; git status", "/w/a")).toBe("/w/b")
    expect(commandFolder('cd "/with space" && ls', "/w")).toBe("/with space")
    expect(commandFolder("cd '/q'", "/w")).toBe("/q")
    expect(commandFolder("  cd /x/ && ls", "/w")).toBe("/x")
  })

  it("is the cd on a script's first line, and the hook's own where it is the cd's already", () => {
    expect(commandFolder("cd /repo\npnpm test", "/w")).toBe("/repo")
    expect(commandFolder("cd wt/ui && ls", "/p/wt/ui")).toBe("/p/wt/ui")
    expect(commandFolder("cd ui && ls", "/p/build-ui")).toBe("/p/build-ui/ui")
  })

  it("is the hook's own directory for a command with no cd first", () => {
    expect(commandFolder("git status && cd /x", "/w")).toBe("/w")
    expect(commandFolder("cd /x | cat", "/w")).toBe("/w")
    expect(commandFolder(undefined, "/w")).toBe("/w")
  })

  it("is nothing for a home, a variable or the last folder, or with nothing absolute to go by", () => {
    expect(commandFolder("cd ~/repo && ls", "/w")).toBeUndefined()
    expect(commandFolder("cd $REPO && ls", "/w")).toBeUndefined()
    expect(commandFolder("cd - && ls", "/w")).toBeUndefined()
    expect(commandFolder("cd sub && ls", "relative")).toBeUndefined()
    expect(commandFolder("ls", undefined)).toBeUndefined()
    expect(commandFolder("cd /abs && ls", undefined)).toBe("/abs")
  })

  it("follows a Windows agent's own paths, whichever system runs the runner", () => {
    expect(commandFolder("ls", "C:\\w", "D:\\x\\y")).toBe("D:\\x\\y")
    expect(commandFolder("ls", "C:\\w", "sub")).toBe("C:\\w\\sub")
    expect(commandFolder('cd "D:\\tasks\\b\\repo" && pnpm test', "C:\\w")).toBe(
      "D:\\tasks\\b\\repo",
    )
    expect(commandFolder("cd D:/tasks/b && ls", "C:\\w")).toBe("D:\\tasks\\b")
    expect(commandFolder("cd ..\\b; git status", "C:\\w\\a")).toBe("C:\\w\\b")
    expect(commandFolder("cd \\x && ls", "C:\\w")).toBe("C:\\x")
    expect(commandFolder("ls", "\\\\host\\share\\w")).toBe("\\\\host\\share\\w")
  })

  it("is where PowerShell's Set-Location or Push-Location moves it, by any of their names", () => {
    const w = "C:\\w"
    for (const move of [
      "Set-Location",
      "set-location",
      "sl",
      "chdir",
      "cd",
      "Push-Location",
      "pushd",
    ])
      expect(commandFolder(`${move} D:\\tasks\\b; npm test`, w), move).toBe("D:\\tasks\\b")
    expect(commandFolder("Set-Location -Path D:\\b; npm test", w)).toBe("D:\\b")
    expect(commandFolder("Set-Location -LiteralPath 'D:\\with space'; ls", w)).toBe(
      "D:\\with space",
    )
    expect(commandFolder('Push-Location -LiteralPath "wt\\docs"; ls', w)).toBe("C:\\w\\wt\\docs")
    expect(commandFolder("sl -path ..\\b\nnpm test", "C:\\w\\a")).toBe("C:\\w\\b")
    expect(commandFolder("Set-Location D:\\b && npm test", w)).toBe("D:\\b")
    // A shell's own pushd and chdir move it as cd does.
    expect(commandFolder("pushd /x && ls", "/w")).toBe("/x")
    expect(commandFolder("chdir /x; ls", "/w")).toBe("/x")
  })

  it("is nothing for a PowerShell move to a variable, home or the last folder", () => {
    expect(commandFolder("Set-Location $env:REPO; ls", "C:\\w")).toBeUndefined()
    expect(commandFolder("Set-Location -Path ~\\repo; ls", "C:\\w")).toBeUndefined()
    expect(commandFolder("Set-Location -; ls", "C:\\w")).toBeUndefined()
    expect(commandFolder("Set-Location D:\\b | Out-Null", "C:\\w")).toBe("C:\\w")
    expect(commandFolder("Set-LocationX D:\\b; ls", "C:\\w")).toBe("C:\\w")
  })

  it("reads Git Bash's drive folders, as Claude Code's Bash on Windows writes them", () => {
    expect(commandFolder("cd /d/tasks/b && ls", "C:\\w")).toBe("D:\\tasks\\b")
    expect(commandFolder("cd /c && ls", "C:\\w")).toBe("C:\\")
  })

  it("is the Windows hook's own directory where it is the cd's already, in any case", () => {
    expect(commandFolder("cd wt/ui && ls", "C:\\p\\wt\\ui")).toBe("C:\\p\\wt\\ui")
    expect(commandFolder("cd WT\\UI && ls", "C:\\p\\wt\\ui")).toBe("C:\\p\\wt\\ui")
    expect(commandFolder("cd ui && ls", "C:\\p\\build-ui")).toBe("C:\\p\\build-ui\\ui")
  })

  it("is nothing on Windows for a drive's own current folder or with no drive to go by", () => {
    expect(commandFolder("cd sub && ls", "C:w")).toBeUndefined()
    expect(commandFolder("cd \\x && ls", undefined)).toBeUndefined()
    expect(commandFolder("cd D:\\abs && ls", undefined)).toBe("D:\\abs")
  })
})

describe("when a hook was fired", () => {
  it("is given to the facts its hook told, not those read since", () => {
    const read = { ...started, startedAt: 4 }
    expect(firedFacts([started, read], { seq: 10, firedAt: 8 })).toEqual([
      { ...started, firedAt: 8 },
      read,
    ])
  })

  it("is given to none where the relay couldn't tell", () => {
    expect(firedFacts([started], { seq: 10 })).toEqual([started])
  })
})

describe("a plan's text", () => {
  it("is kept whole within the protocol's bound", () => {
    expect(planText("the plan")).toEqual({ text: "the plan", truncated: false })
  })

  it("is cut at the bound, a character left whole", () => {
    expect(planText("x".repeat(maxPlan + 1))).toEqual({
      text: "x".repeat(maxPlan),
      truncated: true,
    })
    expect(planText(`${"x".repeat(maxPlan - 1)}😀`)).toEqual({
      text: "x".repeat(maxPlan - 1),
      truncated: true,
    })
  })
})

describe("a permission request's call id", () => {
  it("is the same whatever order its input's keys come in", () => {
    expect(callId(null, "Bash", { command: "ls", timeout: 5 })).toBe(
      callId(null, "Bash", { timeout: 5, command: "ls" }),
    )
  })

  it("differs by actor, tool and input", () => {
    const root = callId(null, "Bash", { command: "ls" })
    expect(callId("a1", "Bash", { command: "ls" })).not.toBe(root)
    expect(callId(null, "Read", { command: "ls" })).not.toBe(root)
    expect(callId(null, "Bash", { command: "pwd" })).not.toBe(root)
  })
})
