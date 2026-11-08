import { terminalFixture } from "@novadeck/core/testing"
import type { AgentStatus, TerminalMetadata } from "@novadeck/core/types"

import { context, describe, expect, it } from "../test"
import { commandText, nothingToCheck, restartCheck, type RestartBusy } from "./restart-check"

const shell = (id: number, name = `Shell ${id}`): TerminalMetadata => ({
  ...terminalFixture(id, "~/project"),
  name,
})
const running = (id: number, process: string, name = `Terminal ${id}`): TerminalMetadata => ({
  ...terminalFixture(id, "~/project"),
  name,
  process,
  state: "running",
})
const told = (busy: string[], unknown: string[] = []): RestartBusy => ({
  busy: new Set(busy),
  unknown: new Set(unknown),
})
const agent = (
  id: number,
  process: string,
  status: Partial<AgentStatus> = {},
): TerminalMetadata => ({
  ...running(id, process),
  state: "running",
  agent: { working: true, ...status },
})

describe("restart check", () => {
  it("has nothing to say of no terminals", () => {
    expect(restartCheck([])).toEqual(nothingToCheck)
  })

  it("reopens shells at their prompt, whichever shell and OS", () => {
    const shells = ["bash", "zsh", "fish", "pwsh", "cmd"].map((process, index) => ({
      ...shell(index + 1),
      process,
    }))
    expect(restartCheck(shells)).toEqual({ resume: 0, reopen: 5, risks: [] })
  })

  context("agents of each harness", () => {
    it("resume mid-turn and reopen otherwise, asleep, idle or paused included", () => {
      const terminals = [
        agent(1, "claude"),
        agent(2, "codex"),
        agent(3, "agy"),
        agent(4, "claude", { working: false }),
        { ...running(5, "codex") },
        { ...shell(6), state: "sleeping", agent: "claude" } as TerminalMetadata,
      ]
      expect(restartCheck(terminals)).toEqual({ resume: 3, reopen: 3, risks: [] })
    })

    it("reopen, not resume, while held on a dialog that waits for the person", () => {
      const held = agent(1, "claude", { attention: { kind: "permission", count: 1 } })
      expect(restartCheck([held])).toEqual({ resume: 0, reopen: 1, risks: [] })
      // One that asks without waiting leaves its turn running.
      const detached = agent(2, "codex", {
        attention: { kind: "question", count: 1, detached: true },
      })
      expect(restartCheck([detached]).resume).toBe(1)
    })

    it("resume while idle on background work or a wake-up they set", () => {
      const waiting = agent(1, "claude", {
        working: false,
        waiting: {
          jobs: [{ id: "j", description: null, command: "pnpm dev", since: 1, until: null }],
          wake: null,
        },
      })
      expect(restartCheck([waiting], undefined, 1).resume).toBe(1)
    })

    it("never stop, even where the platform names no process and the terminal looks busy", () => {
      const windows: TerminalMetadata = { ...agent(1, ""), busy: true }
      const unheard: TerminalMetadata = { ...running(2, "codex"), busy: true }
      expect(restartCheck([windows, unheard], told([]))).toEqual({
        resume: 1,
        reopen: 1,
        risks: [],
      })
    })

    it("lose to a program in the foreground once the agent has quit, whatever flag it left", () => {
      const stale: TerminalMetadata = {
        ...agent(1, "node"),
        argv: ["node", "/lib/pnpm/bin/pnpm.cjs", "dev"],
      }
      const check = restartCheck([stale])
      expect(check.resume).toBe(0)
      expect(check.risks).toEqual([
        { kind: "stops", id: "01", title: "Terminal 1", command: "pnpm dev" },
      ])
    })
  })

  context("agents started through a wrapper", () => {
    const via = (process: string, ...argv: string[]): TerminalMetadata => ({
      ...agent(1, process),
      argv: [process, ...argv],
    })
    const resumed = (terminal: TerminalMetadata) => restartCheck([terminal])

    it("are agents, never stopping, in each harness's own forms", () => {
      const forms = [
        // Claude Code: as npm installs it, and the package npx, pnpm dlx and bunx run.
        via("node", "/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
        via("node", "/npm/npx-cli.js", "@anthropic-ai/claude-code"),
        via("node", "/p/pnpm.cjs", "dlx", "@anthropic-ai/claude-code@latest"),
        via("bun", "x", "@anthropic-ai/claude-code"),
        // Codex likewise.
        via("node", "/lib/node_modules/@openai/codex/bin/codex.js"),
        via("node", "/npm/npx-cli.js", "@openai/codex"),
        via("bun", "x", "@openai/codex@0.1.0"),
        // Antigravity is native: its process is its name, here and as Windows hides it.
        agent(1, "agy"),
        agent(1, ""),
      ]
      for (const form of forms) expect(resumed(form)).toEqual({ resume: 1, reopen: 0, risks: [] })
    })

    it("lose to a program that only has the agent's leftover flag", () => {
      expect(resumed(via("node", "/p/pnpm.cjs", "dev")).risks).toHaveLength(1)
      // An editor an agent opened (Claude Code's Ctrl+G) stops: what is edited is lost.
      expect(resumed(via("vim", "/tmp/prompt.md")).risks).toEqual([
        { kind: "stops", id: "01", title: "Terminal 1", command: "vim" },
      ])
    })
  })

  context("an agent's shell's own jobs", () => {
    it("are a risk beside the agent's resume, whichever harness", () => {
      for (const program of ["claude", "codex", "agy"]) {
        const check = restartCheck([agent(1, program)], told(["01"]))
        expect(check.resume).toBe(1)
        expect(check.risks).toEqual([{ kind: "unknown", id: "01", title: "Terminal 1" }])
      }
    })

    it("are one too where the runner couldn't read the shell", () => {
      const check = restartCheck([agent(1, "claude")], told([], ["01"]))
      expect(check.risks).toEqual([{ kind: "unknown", id: "01", title: "Terminal 1" }])
    })

    it("are none where the runner finds nothing beside the agent", () => {
      expect(restartCheck([agent(1, "claude")], told([])).risks).toEqual([])
    })

    it("are not shown again where the agent names its own work, which the runner sees too", () => {
      const polling = agent(1, "claude", {
        working: false,
        waiting: {
          jobs: [
            { id: "j", description: "Wait", command: "gh pr checks 1", since: 1, until: null },
          ],
          wake: null,
        },
      })
      const codex = agent(2, "codex", { background: { agents: 0, tasks: 1 } })
      const agy = agent(3, "agy", { background: { agents: 1, tasks: 0 } })
      const check = restartCheck([polling, codex, agy], told(["01", "02", "03"]), 1)
      expect(check.risks.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
        "agent:01",
        "agent:02",
        "agent:03",
      ])
    })
  })

  context("a shell the runner could not read", () => {
    it("may stop, as one with work does", () => {
      expect(restartCheck([shell(1, "Quiet")], told([], ["01"])).risks).toEqual([
        { kind: "unknown", id: "01", title: "Quiet" },
      ])
    })
  })

  context("work an agent started", () => {
    const risk = (terminal: TerminalMetadata) => restartCheck([terminal], undefined, 1).risks

    it("stops with Claude Code's background command, named", () => {
      const claude = agent(1, "claude", {
        working: false,
        waiting: {
          jobs: [{ id: "j", description: "dev", command: "pnpm dev", since: 1, until: null }],
          wake: null,
        },
        background: { agents: 0, tasks: 1 },
      })
      expect(risk(claude)).toEqual([
        {
          kind: "agent",
          id: "01",
          title: "Terminal 1",
          command: "pnpm dev",
          what: "1 background command stops",
        },
      ])
    })

    it("stops with Codex's background tasks, counted, where it names no command", () => {
      const codex = agent(2, "codex", { background: { agents: 0, tasks: 2 } })
      expect(risk(codex)).toEqual([
        { kind: "agent", id: "02", title: "Terminal 2", what: "2 background commands stop" },
      ])
    })

    it("stops with Antigravity's background agents, counted", () => {
      const agy = agent(3, "agy", { background: { agents: 1, tasks: 0 } })
      expect(risk(agy)).toEqual([
        { kind: "agent", id: "03", title: "Terminal 3", what: "1 subagent stops" },
      ])
      const both = agent(4, "agy", { background: { agents: 2, tasks: 1 } })
      expect(risk(both)[0]).toMatchObject({ what: "1 background command and 2 subagents stop" })
    })

    it("falls back to words where its command is empty, begins with a value or is shell syntax", () => {
      for (const command of [
        "",
        "   ",
        "KEY=x pnpm dev",
        "for i in $(seq 1 60); do gh pr checks 1 && break; sleep 30; done",
        "while true; do sleep 1; done",
        "(cd web && pnpm dev)",
      ]) {
        const claude = agent(1, "claude", {
          working: false,
          waiting: {
            jobs: [{ id: "j", description: null, command, since: 1, until: null }],
            wake: null,
          },
        })
        const [found] = risk(claude)
        expect(found).toMatchObject({ kind: "agent", what: "1 background command stops" })
        expect(found).not.toHaveProperty("command")
      }
    })

    it("says nothing of an agent with no background work", () => {
      expect(risk(agent(5, "claude", { background: { agents: 0, tasks: 0 } }))).toEqual([])
    })
  })

  context("programs in plain shells", () => {
    it("stop, named from their command line", () => {
      const dev: TerminalMetadata = {
        ...running(2, "node", "Order status page"),
        argv: ["node", "/usr/lib/pnpm/bin/pnpm.cjs", "dev"],
      }
      const check = restartCheck([shell(1), dev])
      expect(check.risks).toEqual([
        { kind: "stops", id: "02", title: "Order status page", command: "pnpm dev" },
      ])
      expect(check.reopen).toBe(1)
    })

    it("may stop where the roster says idle and the runner sees work, a job or a program", () => {
      const jobs = restartCheck([shell(1, "Jobs"), shell(2)], told(["01"]))
      expect(jobs.risks).toEqual([{ kind: "unknown", id: "01", title: "Jobs" }])
      expect(jobs.reopen).toBe(1)
    })

    it("may stop where the platform can't name the program, with no runner word needed", () => {
      const blind: TerminalMetadata = { ...shell(1, "Stripe webhooks"), process: "", busy: true }
      expect(restartCheck([blind, shell(2)]).risks).toEqual([
        { kind: "unknown", id: "01", title: "Stripe webhooks" },
      ])
    })

    it("stops once, by its command, when the runner agrees with the roster", () => {
      const check = restartCheck([running(1, "vite")], told(["01"]))
      expect(check.risks).toHaveLength(1)
      expect(check.risks[0]).toMatchObject({ kind: "stops", command: "vite" })
    })
  })

  it("leaves ended terminals out and reopens one still starting", () => {
    const terminals: TerminalMetadata[] = [
      { ...shell(1), state: "exited", exitCode: 0, signal: null },
      { ...shell(2), state: "failed", message: "no shell" },
      { ...shell(3), state: "starting" },
    ]
    expect(restartCheck(terminals)).toEqual({ resume: 0, reopen: 1, risks: [] })
  })
})

describe("command text", () => {
  it("keeps the program and its plain words, and stops at the first option or value", () => {
    expect(commandText("pnpm", ["pnpm", "test", "--watch"])).toBe("pnpm test")
    expect(commandText("mysql", ["mysql", "-uroot", "-psecret"])).toBe("mysql")
    expect(commandText("docker", ["docker", "run", "-e", "PASSWORD=x", "img"])).toBe("docker run")
    expect(commandText("env", ["env", "API_KEY=abc", "node", "x"])).toBe("env")
    expect(commandText("curl", ["curl", "-u", "a:b", "https://host/x"])).toBe("curl")
    expect(commandText("sshpass", ["sshpass", "-p", "x", "ssh", "host"])).toBe("sshpass")
    expect(commandText("git", ["git", "clone", "https://me:pw@host/r.git"])).toBe("git clone")
    expect(commandText("npx", ["npx", "@scope/pkg", "go"])).toBe("npx")
    expect(commandText("npm", ["npm", "run", "dev:watch"])).toBe("npm run")
  })

  it("stops at a path to a file that isn't a script, and shows a script by its file name", () => {
    expect(commandText("vim", ["vim", "/etc/hosts"])).toBe("vim")
    expect(commandText("bash", ["/bin/bash", "./deploy.sh", "prod"])).toBe("bash deploy.sh prod")
    expect(commandText("tail", ["tail", "C:\\logs\\app.log"])).toBe("tail")
  })

  it("reads at most four words", () => {
    expect(commandText("x", ["x", "a", "b", "c", "d", "e"])).toBe("x a b c")
  })

  it("reads a package manager's entry script as the manager, Windows paths too", () => {
    expect(commandText("node", ["node", "/a/npm-cli.js", "run", "dev"])).toBe("npm run dev")
    expect(commandText("node", ["node", "/a/npx-cli.js", "vite"])).toBe("npx vite")
    expect(commandText("node", ["node", "/a/yarn.js", "dev"])).toBe("yarn dev")
    expect(
      commandText("node", ["C:\\Program Files\\nodejs\\node.exe", "C:\\p\\pnpm.cjs", "dev"]),
    ).toBe("pnpm dev")
  })

  it("keeps the interpreter and the script's file name for any other script", () => {
    expect(commandText("python3", ["/usr/bin/python3", "manage.py", "runserver"])).toBe(
      "python3 manage.py runserver",
    )
    expect(commandText("node", ["node", "/srv/app/server.js", "--port", "80"])).toBe(
      "node server.js",
    )
    expect(commandText("python3", ["/usr/bin/python3", "-m", "http.server"])).toBe("python3")
  })

  it("drops .exe from a program", () => {
    expect(commandText("cargo", ["C:\\bin\\cargo.exe", "watch"])).toBe("cargo watch")
  })

  it("falls back to the process name without a command line", () => {
    expect(commandText("vite", undefined)).toBe("vite")
    expect(commandText("vite", [])).toBe("vite")
  })

  it("cuts a long command with an ellipsis", () => {
    const text = commandText("x", ["x", "a".repeat(60)])
    expect(text).toHaveLength(40)
    expect(text.endsWith("…")).toBe(true)
  })
})
