import { describe, expect, it } from "vitest"

import { codex } from "./index.js"
import { approveNovadeck } from "./shim.js"

const { kept, resume } = codex.launch

describe("the flags a resumed Codex keeps", () => {
  it("are its approval policy, sandbox, model and effort, in any spelling it reads", () => {
    expect(kept!(["--ask-for-approval", "never", "--sandbox", "danger-full-access"])).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "danger-full-access",
    ])
    expect(kept!(["-a", "on-request", "-s", "read-only", "-m", "gpt-5"])).toEqual([
      "--ask-for-approval",
      "on-request",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-5",
    ])
    expect(kept!(["-sread-only", "--model=gpt-5", "-a=never"])).toEqual([
      "--sandbox",
      "read-only",
      "--model",
      "gpt-5",
      "--ask-for-approval",
      "never",
    ])
    expect(kept!(["--dangerously-bypass-approvals-and-sandbox"])).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ])
    expect(kept!(["--full-auto", "--approve-for-me", "--dangerously-bypass-hook-trust"])).toEqual([
      "--full-auto",
      "--approve-for-me",
      "--dangerously-bypass-hook-trust",
    ])
  })

  it("keep the config overrides of those settings and no other", () => {
    expect(
      kept!([
        "-c",
        "model_reasoning_effort=high",
        "--config",
        "approval_policy=never",
        "-c",
        "sandbox_mode=read-only",
        "-c",
        "model=gpt-5",
      ]),
    ).toEqual([
      "-c",
      "model_reasoning_effort=high",
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=read-only",
      "-c",
      "model=gpt-5",
    ])
    // The shim's title setting, and the person's other overrides, are not its to repeat.
    expect(kept!(["-c", "tui.terminal_title=[x]", "-c", "mcp_servers.x.command=y"])).toEqual([])
    expect(kept!(["-c", "approval_policy=never", "-c", "approval_policy=untrusted"])).toEqual([
      "-c",
      "approval_policy=untrusted",
    ])
  })

  it("leave out a prompt, a positional, the session, its profile and what it doesn't know", () => {
    expect(kept!(["resume", "019f-aaaa", "--sandbox", "read-only"])).toEqual([
      "--sandbox",
      "read-only",
    ])
    expect(kept!(["write a test", "--last"])).toEqual([])
    expect(kept!(["-p", "work", "--search", "--image", "a.png", "b.png"])).toEqual([])
    expect(kept!(["--add-dir", "/x", "-s", "read-only"])).toEqual(["--sandbox", "read-only"])
    expect(kept!(["--no-daemon", "--unknown", "-m", "gpt-5"])).toEqual(["--model", "gpt-5"])
  })

  it("give back only the hook trust bypass, which its session doesn't hold", () => {
    const launched = kept!([
      "-m",
      "gpt-5",
      "-c",
      "model_reasoning_effort=high",
      "--ask-for-approval",
      "never",
      "--dangerously-bypass-hook-trust",
    ])
    expect(launched).toContain("--ask-for-approval")
    expect(resume!("s-1", {}, launched)).toEqual([
      "codex",
      "resume",
      "--dangerously-bypass-hook-trust",
      "-c",
      "tui.resume_cwd=session",
      "s-1",
    ])
    expect(resume!("s-1", { model: "o4", effort: "low" }, launched)).toEqual([
      "codex",
      "resume",
      "--model",
      "o4",
      "-c",
      "model_reasoning_effort=low",
      "--dangerously-bypass-hook-trust",
      "-c",
      "tui.resume_cwd=session",
      "s-1",
    ])
    const bare = ["codex", "resume", "-c", "tui.resume_cwd=session", "s-1"]
    expect(resume!("s-1", {}, kept!(["-m", "gpt-5", "-a", "never"]))).toEqual(bare)
    expect(resume!("s-1")).toEqual(bare)
  })

  // A resume through the shim, which gives the session the folder of agents' worktrees to
  // write, runs workspace-write unless it's told the sandbox again (probed 2026-11-27, 0.172.0).
  it("gives the sandbox back, however it was asked for, so a read-only session stays read-only", () => {
    const resumed = (launch: readonly string[]) => resume!("s-1", {}, kept!(launch)).slice(2, -3)
    expect(resumed(["-s", "read-only", "-a", "never"])).toEqual(["--sandbox", "read-only"])
    expect(resumed(["--sandbox=workspace-write"])).toEqual(["--sandbox", "workspace-write"])
    expect(resumed(["-c", "sandbox_mode=read-only"])).toEqual(["-c", "sandbox_mode=read-only"])
    // Refused by Codex from 0.171.0: a session saved with it resumes without it.
    expect(resumed(["--full-auto"])).toEqual([])
    expect(resumed(["--dangerously-bypass-approvals-and-sandbox"])).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ])
  })
})

describe("what the shim adds to let Novadeck's tools run", () => {
  it("is never kept, so each launch and resume gets it afresh from the shim", () => {
    expect(codex.launch.kept!(["--no-daemon", "-c", approveNovadeck, "-m", "gpt-5"])).toEqual([
      "--model",
      "gpt-5",
    ])
  })
})

describe("the choice a Codex agent opens its own kind on", () => {
  it("is its model and effort, as flags or as config overrides, and no approval or sandbox", () => {
    const flags = kept!(["-m", "gpt-6", "-s", "read-only", "-c", "model_reasoning_effort=high"])
    expect(codex.launch.chosen!(flags)).toEqual({ model: "gpt-6", effort: "high" })
    const config = kept!(["-c", "model=gpt-5", "-a", "never", "-c", "model_reasoning_effort=low"])
    expect(codex.launch.chosen!(config)).toEqual({ model: "gpt-5", effort: "low" })
  })
})
