import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentDetail } from "@novadeck/protocol"

import { describe, expect } from "../test.js"
import { bash, it, create, reporter } from "./integration.test-support.js"

// A line of a Claude Code transcript: the person's message.
const userLine = (text: string) =>
  `${JSON.stringify({ type: "user", timestamp: "2026-09-30T08:00:00Z", message: { content: text } })}\n`

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "bash shell integration: what a terminal shows of its agent",
  () => {
    it("shows what the agent is doing, and the requests waiting on the person", async ({
      shell,
    }) => {
      const call = { tool_name: "Bash", tool_input: { command: "touch x" } }
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "s", seq: 1, source: "startup" },
        { agent: "claude", sessionId: "s", seq: 2, source: "", event: "UserPromptSubmit" },
        {
          agent: "claude",
          sessionId: "s",
          seq: 3,
          source: "",
          event: "PermissionRequest",
          fields: call,
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const next = shell.watch(manager)
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await next(
        (summary) =>
          summary.id === terminal.id &&
          summary.activity?.state === "working" &&
          summary.activity.attention.pending === 1 &&
          summary.activity.attention.kind === "permission",
      )
      // Returning to the prompt ends the agent, and its activity with it.
      manager.write({ terminalId: terminal.id, data: "\u0003" }, "owner")
      await expect
        .poll(() => manager.list(terminal.sessionId)[0], { timeout: 10_000 })
        .toMatchObject({ agent: null, activity: null })
    })

    it("ends a Claude Code turn its transcript says the person interrupted", async ({ shell }) => {
      // No hook reports an Esc or a denial; the session's transcript records them.
      const transcript = join(shell.home, "session.jsonl")
      writeFileSync(transcript, "")
      const call = { tool_name: "Bash", tool_input: { command: "touch x" } }
      const bin = reporter(shell.home, [
        {
          agent: "claude",
          sessionId: "s",
          seq: 1,
          source: "startup",
          fields: { transcript_path: transcript },
        },
        { agent: "claude", sessionId: "s", seq: 2, source: "", event: "UserPromptSubmit" },
        {
          agent: "claude",
          sessionId: "s",
          seq: 3,
          source: "",
          event: "PermissionRequest",
          fields: call,
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      const activity = () => manager.list(terminal.sessionId)[0]?.activity
      await expect.poll(activity, { timeout: 10_000 }).toMatchObject({ attention: { pending: 1 } })
      expect(manager.messages(terminal.id).delivery).toBe("working")
      appendFileSync(
        transcript,
        `${JSON.stringify({
          type: "user",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
          },
        })}\n`,
      )
      await expect.poll(activity, { timeout: 10_000 }).toEqual({
        state: "idle",
        attention: { pending: 0, kind: null },
        subagents: [],
        planning: false,
        background: null,
        waiting: null,
        lastTurn: {
          outcome: "interrupted",
          reply: null,
          at: expect.any(Number),
          error: null,
          limit: null,
          files: [],
        },
      })
      // Messaging hears it too: the turn ended without a Stop.
      expect(manager.messages(terminal.id).delivery).toBe("unknown")
    })

    it("tells how a Claude Code turn ended, with the start of the agent's last reply", async ({
      shell,
    }) => {
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "s", seq: 1, source: "startup" },
        { agent: "claude", sessionId: "s", seq: 2, source: "", event: "UserPromptSubmit" },
        {
          agent: "claude",
          sessionId: "s",
          seq: 3,
          source: "",
          event: "Stop",
          fields: { last_assistant_message: "## Done\n\nAll **green**:\u001b[31m 42 specs" },
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await expect
        .poll(() => manager.list(terminal.sessionId)[0]?.activity, { timeout: 10_000 })
        .toMatchObject({
          state: "idle",
          lastTurn: { outcome: "completed", reply: "Done All green: 42 specs" },
        })
    })

    it("reads an Antigravity agent's last reply from its transcript, as its Stop names none", async ({
      shell,
    }) => {
      const transcript = join(shell.home, "transcript.jsonl")
      writeFileSync(
        transcript,
        `${[
          { source: "USER_EXPLICIT", type: "USER_INPUT", step_index: 0, content: "Make it" },
          { source: "MODEL", type: "PLANNER_RESPONSE", step_index: 1, content: "Made it." },
        ]
          .map((step) => JSON.stringify(step))
          .join("\n")}\n`,
      )
      const fields = { transcriptPath: transcript }
      const bin = reporter(shell.home, [
        {
          agent: "agy",
          sessionId: "c",
          seq: 1,
          source: "",
          fields: { ...fields, invocationNum: 0 },
        },
        { agent: "agy", sessionId: "c", seq: 2, source: "", event: "Stop", fields },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await expect
        .poll(() => manager.list(terminal.sessionId)[0]?.activity, { timeout: 10_000 })
        .toMatchObject({ state: "idle", lastTurn: { outcome: "completed", reply: "Made it." } })
    })

    it("ends a Claude Code turn its transcript says its Stop hooks ran, its own report lost", async ({
      shell,
    }) => {
      // As when Novadeck's Stop hook failed to run: the transcript still records the hooks.
      const transcript = join(shell.home, "session.jsonl")
      writeFileSync(transcript, "")
      const bin = reporter(shell.home, [
        {
          agent: "claude",
          sessionId: "s",
          seq: 1,
          source: "startup",
          fields: { transcript_path: transcript },
        },
        { agent: "claude", sessionId: "s", seq: 2, source: "", event: "UserPromptSubmit" },
        {
          agent: "claude",
          sessionId: "s",
          seq: 3,
          source: "",
          event: "SubagentStart",
          fields: { agent_id: "a1", agent_type: "general-purpose" },
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      const activity = () => manager.list(terminal.sessionId)[0]?.activity
      await expect
        .poll(activity, { timeout: 10_000 })
        .toMatchObject({ subagents: [{ type: "general-purpose" }] })
      expect(activity()).toMatchObject({ state: "working", background: null })
      appendFileSync(
        transcript,
        `${JSON.stringify({
          isSidechain: false,
          type: "system",
          subtype: "stop_hook_summary",
          hookErrors: ["Failed to run"],
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        })}\n`,
      )
      // Nothing says what runs on but its hooks: its subagent, which wakes it once done.
      await expect
        .poll(activity, { timeout: 10_000 })
        .toMatchObject({ state: "working", background: { agents: 1, tasks: 0 } })
      expect(manager.messages(terminal.id).delivery).toBe("working")
    })

    it("shows a Codex session's context and rate limits from its rollout", async ({ shell }) => {
      const rollout = join(shell.home, "rollout.jsonl")
      writeFileSync(rollout, "")
      const bin = reporter(shell.home, [
        {
          agent: "codex",
          sessionId: "s",
          seq: 1,
          source: "startup",
          fields: { transcript_path: rollout },
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await expect
        .poll(() => manager.list(terminal.sessionId)[0]?.agent, { timeout: 10_000 })
        .toBe("codex")
      appendFileSync(
        rollout,
        `${JSON.stringify({
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: { total_tokens: 30_000 }, model_context_window: 200_000 },
            rate_limits: {
              primary: { used_percent: 40, window_minutes: 300, resets_at: 1_800_000_000 },
              secondary: null,
            },
          },
        })}\n`,
      )
      await expect
        .poll(() => manager.list(terminal.sessionId)[0]?.telemetry, { timeout: 10_000 })
        .toEqual({
          context: { occupied: 30_000, capacity: 200_000 },
          limits: [{ minutes: 300, used: 0.4, resetsAt: 1_800_000_000_000 }],
          model: null,
          effort: null,
        })
    })

    it("starts a switched session's activity afresh", async ({ shell }) => {
      const call = { tool_name: "Bash", tool_input: { command: "touch x" } }
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "s1", seq: 1, source: "startup" },
        { agent: "claude", sessionId: "s1", seq: 2, source: "", event: "UserPromptSubmit" },
        {
          agent: "claude",
          sessionId: "s1",
          seq: 3,
          source: "",
          event: "PermissionRequest",
          fields: call,
        },
        // /clear in the agent in the foreground.
        { agent: "claude", sessionId: "s2", seq: 4, source: "clear" },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      await expect
        .poll(() => manager.list(terminal.sessionId)[0]?.activity, { timeout: 10_000 })
        .toEqual({
          state: "idle",
          attention: { pending: 0, kind: null },
          subagents: [],
          planning: false,
          background: null,
          waiting: null,
          lastTurn: null,
        })
      expect(manager.reportedSession(terminal.id, "claude")).toBe("s2")
    })

    it("streams the agent's detail as its hooks change it, until the terminal closes", async ({
      shell,
    }) => {
      const call = { tool_name: "Bash", tool_input: { command: "touch x" } }
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "s1", seq: 1, source: "startup" },
        { agent: "claude", sessionId: "s1", seq: 2, source: "", event: "UserPromptSubmit" },
        {
          agent: "claude",
          sessionId: "s1",
          seq: 3,
          source: "",
          event: "PermissionRequest",
          fields: call,
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      const snapshots: AgentDetail[] = []
      const reading = (async () => {
        for await (const detail of manager.detail(terminal.id)) snapshots.push(detail)
      })()
      await expect.poll(() => snapshots[0]).toMatchObject({ terminalId: terminal.id, agent: null })
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      await expect
        .poll(() => snapshots.at(-1)?.requests, { timeout: 10_000 })
        .toMatchObject([{ kind: "permission", tool: "Bash", subject: "touch x" }])
      expect(snapshots.at(-1)).toMatchObject({ agent: "claude", sessionId: "s1" })
      // Disconnecting the agent ends its binding.
      manager.forgetAgent("claude")
      await expect.poll(() => snapshots.at(-1)).toMatchObject({ agent: null, requests: [] })
      await manager.close({ terminalId: terminal.id })
      await reading
      await expect(manager.detail(terminal.id).next()).rejects.toMatchObject({
        code: "TERMINAL_NOT_FOUND",
      })
    })

    it("streams an agent's transcript until the agent leaves its session", async ({ shell }) => {
      const transcript = join(shell.home, "s1.jsonl")
      writeFileSync(transcript, userLine("first"))
      const bin = reporter(shell.home, [
        {
          agent: "claude",
          sessionId: "s1",
          seq: 1,
          source: "startup",
          fields: { transcript_path: transcript },
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      const details = manager.detail(terminal.id)
      let root: string | undefined
      while (!root) {
        // eslint-disable-next-line no-await-in-loop -- Reads snapshots until the agent binds.
        const { value } = await details.next()
        root = value?.actors[0]?.ref
      }
      await details.return(undefined)
      await expect(manager.transcript(terminal.id, "x".repeat(16)).next()).rejects.toMatchObject({
        code: "NOT_FOUND",
      })
      const texts: string[] = []
      const reading = (async () => {
        for await (const change of manager.transcript(terminal.id, root))
          if (change.type === "items") texts.push(...change.items.map(({ text }) => text))
      })()
      await expect.poll(() => texts).toEqual(["first"])
      appendFileSync(transcript, userLine("second"))
      await expect.poll(() => texts, { timeout: 5_000 }).toEqual(["first", "second"])
      manager.forgetAgent("claude")
      await reading
    })

    it("takes a transcript from a later report when the status line bound the session", async ({
      shell,
    }) => {
      const transcript = join(shell.home, "transcript_full.jsonl")
      writeFileSync(
        transcript,
        `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>\nhi\n</USER_REQUEST>" })}\n`,
      )
      const bin = reporter(shell.home, [
        // Antigravity's status line names the conversation, but not its transcript.
        {
          agent: "agy",
          sessionId: "c1",
          seq: 1,
          source: "",
          event: "StatusLine",
          fields: { conversation_id: "c1", agent_state: "idle" },
        },
        {
          agent: "agy",
          sessionId: "c1",
          seq: 2,
          source: "",
          event: "PreInvocation",
          fields: { transcriptPath: transcript },
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
        // Each report waits, as macOS's slower foreground lookup makes it, so the report that
        // names the transcript is still queued when the status line has bound the session.
        connected: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300))
          return true
        },
      })
      const next = shell.watch(manager)
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      const details = manager.detail(terminal.id)
      let root: string | undefined
      while (!root) {
        // eslint-disable-next-line no-await-in-loop -- Reads snapshots until the agent binds.
        const { value } = await details.next()
        root = value?.actors[0]?.ref
      }
      await details.return(undefined)
      // The later report, whose model call starts a turn, names the transcript as it is
      // handled; a slower machine takes longer to get there, never a different way.
      await next((summary) => summary.activity?.state === "working")
      const texts: string[] = []
      const reading = (async () => {
        for await (const change of manager.transcript(terminal.id, root))
          if (change.type === "items") texts.push(...change.items.map(({ text }) => text))
      })()
      await expect.poll(() => texts).toEqual(["hi"])
      manager.forgetAgent("agy")
      await reading
    })

    it("starts the turn whose hook fired with the status line that bound its session", async ({
      shell,
    }) => {
      const bin = reporter(shell.home, [
        // Antigravity fires both at once: the status line's starts last, and is heard first.
        {
          agent: "agy",
          sessionId: "c1",
          seq: 2,
          source: "",
          event: "StatusLine",
          fields: { conversation_id: "c1", agent_state: "working" },
        },
        { agent: "agy", sessionId: "c1", seq: 1.99, source: "", event: "PreInvocation" },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const next = shell.watch(manager)
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await next((summary) => summary.activity?.state === "working")
    })

    it("keeps a plan the agent drafts beside its terminal, read as it changes", async ({
      shell,
    }) => {
      const plans = join(shell.home, ".claude", "plans")
      mkdirSync(plans, { recursive: true })
      const path = join(plans, "brave-fox.md")
      writeFileSync(path, "# Plan\n")
      const bin = reporter(shell.home, [
        { agent: "claude", sessionId: "s1", seq: 1, source: "startup" },
        {
          agent: "claude",
          sessionId: "s1",
          seq: 2,
          source: "",
          event: "PostToolUse",
          fields: {
            tool_name: "Write",
            permission_mode: "plan",
            tool_input: { file_path: path, content: "# Plan\n" },
          },
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      await expect
        .poll(() => shell.store.barItems(terminal.id))
        .toMatchObject([{ kind: "plan", name: "Plan", path, plan: { format: "file" } }])
      const [item] = shell.store.barItems(terminal.id)
      const texts: string[] = []
      const controller = new AbortController()
      const reading = (async () => {
        for await (const content of shell
          .items(manager)
          .content(item!.id, undefined, controller.signal))
          if (content.state === "ready" && content.content.kind === "plan")
            texts.push(content.content.text)
      })()
      await expect.poll(() => texts).toEqual(["# Plan\n"])
      writeFileSync(path, "# Plan\n\n1. More\n")
      await expect.poll(() => texts).toEqual(["# Plan\n", "# Plan\n\n1. More\n"])
      controller.abort()
      await reading
    })

    it("keeps a plan presented as text beside its terminal, read back from its transcript", async ({
      shell,
    }) => {
      const transcript = join(shell.home, "s1.jsonl")
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: "assistant",
          timestamp: "2026-09-30T08:00:00Z",
          message: {
            content: [{ type: "tool_use", name: "ExitPlanMode", input: { plan: "# Text plan\n" } }],
          },
        })}\n`,
      )
      const bin = reporter(shell.home, [
        {
          agent: "claude",
          sessionId: "s1",
          seq: 1,
          source: "startup",
          fields: { transcript_path: transcript },
        },
        {
          agent: "claude",
          sessionId: "s1",
          seq: 2,
          source: "",
          event: "PermissionRequest",
          fields: { tool_name: "ExitPlanMode", tool_input: { plan: "# Text plan\n" } },
        },
      ])
      const manager = shell.manager({
        env: { HOME: shell.home, PS1: "$ ", PATH: `${bin}:${process.env.PATH}` },
      })
      const terminal = await create(manager, shell)
      manager.write({ terminalId: terminal.id, data: "report\r" }, "owner")
      await shell.until(manager, terminal.id, "reports sent")
      // The item points at the transcript, never holding the plan's text itself.
      await expect
        .poll(() => shell.store.barItems(terminal.id))
        .toMatchObject([
          {
            kind: "plan",
            name: "Text plan",
            path: transcript,
            plan: { agent: "claude", session: "s1", actor: null, format: "text" },
          },
        ])
      // Another session binding there takes the plan its bar mirrored of the first.
      const next = reporter(shell.home, [
        { agent: "claude", sessionId: "s2", seq: 3, source: "startup" },
      ])
      // The stand-in agent ends, and another starts there.
      manager.write({ terminalId: terminal.id, data: "\x03" }, "owner")
      manager.write({ terminalId: terminal.id, data: `${join(next, "report")}\r` }, "owner")
      await expect.poll(() => shell.store.barItems(terminal.id), { timeout: 10_000 }).toEqual([])
      expect(manager.reportedSession(terminal.id, "claude")).toBe("s2")
    })
  },
)
