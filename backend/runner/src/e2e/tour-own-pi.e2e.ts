import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { delimiter, join } from "node:path"

import { bundledPiHome } from "@novadeck/harness-nova/pin"
import { afterAll, beforeAll } from "vitest"

import type { AgentSetup } from "./agents/agent.js"
import { ownPi } from "./agents/own-pi.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { asked, tool, type Call } from "./model/script.js"
import { ownPiFromCache } from "./own-pi-cache.js"
import { own, prompted, result, turn } from "./scenarios.js"
import { fakeTourService, folder, seedTour } from "./tour-story.js"

// Novadeck's own pi in the tour, past what the story shows (tour-story.e2e.ts): that the tour's
// lead resumes on it when the runner restarts, that the ticket stays out of what the agent runs,
// and that on Windows with no Git Bash it still has a shell to run a command in. The fake model
// plays the agent, and the fake tour service gives the ticket the model accepts.

let restorePi: (() => void) | undefined
beforeAll(async () => {
  restorePi = await ownPiFromCache()
})
afterAll(() => restorePi?.())

// The two variables Novadeck's extension registers the tour's model from, and takes out of pi's
// environment before anything runs.
const variables = "NOVADECK_PI_(KEY|BASE_URL)"

// What the agent prints of them in the shell tool it has: bash where it has one (Linux, macOS,
// and Windows with Git Bash), else PowerShell's own. The `left` count is of every variable of
// those names in the tool's whole environment.
const printing: Readonly<Record<string, string>> = {
  bash: `echo "key=[\${NOVADECK_PI_KEY-}] url=[\${NOVADECK_PI_BASE_URL-}] left=$(env | grep -Ec '^${variables}=')"`,
  powershell: `Write-Output ("key=[" + $env:NOVADECK_PI_KEY + "] url=[" + $env:NOVADECK_PI_BASE_URL + "] left=" + @(Get-ChildItem Env: | Where-Object { $_.Name -match '^${variables}$' }).Count)`,
}

// The shell tool a call offers: pi's `bash`, or its `powershell` where it started without Git Bash.
const shellOf = (call: Call): "bash" | "powershell" => (tool(call, "bash") ? "bash" : "powershell")

// The tour, readied, and its lead started and at its prompt, as the client opens it, with no brief
// rung: the model plays whatever the test scripts.
const leadOf = async (
  run: E2E,
  setup: AgentSetup,
): Promise<{ lead: DeckTerminal; directory: string; restore: () => void }> => {
  await seedTour(run)
  const restore = fakeTourService(run)
  try {
    const prepared = await run.deck.tour.prepare()
    expect(prepared.command).toBe("novadeck-pi --model novadeck/gpt-6-luna --thinking medium")
    const lead = await run.deck.openAt(prepared.directory, prepared.command)
    await lead.reached("ready", { timeoutMs: 60_000 })
    await prompted(lead, setup)
    return { lead, directory: prepared.directory, restore }
  } catch (error) {
    restore()
    throw error
  }
}

describe.skipIf(!supported)(`${ownPi.name} in the tour`, () => {
  const it = e2e.seeded({ trustedInHome: [folder] }, ownPi)

  it("resumes the lead on Novadeck's own pi when the runner restarts, with the ticket again, and never on the person's pi", async ({
    e2e: run,
  }) => {
    const { lead, directory, restore } = await leadOf(run, ownPi)
    try {
      run.model.use(
        own((call) =>
          asked(call, "Remember the word heron") ? { text: "Remembered." } : undefined,
        ),
        own((call) =>
          asked(call, "Which word?")
            ? {
                text: call.turns.some((one) => one.text.includes("Remember the word heron"))
                  ? "Heron, as before."
                  : "I remember nothing.",
              }
            : undefined,
        ),
      )
      await turn(lead, "Remember the word heron", "Remembered.")
      const { sessionId } = await lead.detail()
      expect(sessionId).not.toBeNull()
      // Its session is in Novadeck's own pi's agent folder, which the person's pi never writes.
      const sessions = join(bundledPiHome(join(run.sandbox.root, "data")), "sessions")
      expect(await readdir(sessions, { recursive: true })).toEqual(
        expect.arrayContaining([expect.stringMatching(/\.jsonl$/)]),
      )

      await run.deck.restart()
      // A shell of the folder gets the ticket again only as a resumed one: nothing else's.
      expect(run.deck.tour.launchEnv(directory)).toBeUndefined()
      expect(run.deck.tour.launchEnv(directory, true)).toMatchObject({
        NOVADECK_PI_KEY: expect.any(String),
      })

      const resumed = await run.deck.restore(lead, { resume: "pi" })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, ownPi)
      // Novadeck's own pi again, on its session file from its own agent folder, not the person's pi.
      if (process.platform === "linux") {
        const argv = await resumed.poll(
          () => {
            const words = resumed.summary().process?.argv?.join(" ")
            return words?.includes("--session") ? words : undefined
          },
          "its pi to resume a session",
          45_000,
        )
        expect(argv).toContain(join(run.sandbox.root, "data", "bundled", "pi"))
        expect(argv).toContain(` --session ${sessions}`)
      }
      // The model and thinking level come back with the session (pi restores them itself).
      const screen = await resumed.screen()
      expect(screen).toContain("gpt-6-luna")
      expect(screen).toContain("medium")
      expect((await resumed.detail()).sessionId).toBe(sessionId)

      // The provider and the ticket came back: its next turn reaches the fake model on the tour's
      // service with the conversation it had, and is answered.
      const marked = run.model.mark()
      await resumed.submit("Which word?")
      await resumed.until("Heron, as before.")
      const calls = run.model.calls.slice(marked).filter((call) => !call.side)
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.model).toBe("gpt-6-luna")
      expect(existsSync(join(run.sandbox.home, ".pi"))).toBe(false)
    } finally {
      restore()
    }
  })

  it("keeps the service's address and the ticket out of the commands the lead runs", async ({
    e2e: run,
  }) => {
    const { lead, restore } = await leadOf(run, ownPi)
    try {
      run.model.use(
        own((call) =>
          asked(call, "Print the service settings")
            ? { calls: [{ name: shellOf(call), input: { command: printing[shellOf(call)] } }] }
            : undefined,
        ),
        own((call) =>
          result(call)?.includes("left=") ? { text: "Printed the settings." } : undefined,
        ),
      )
      const marked = run.model.mark()
      await turn(lead, "Print the service settings", "Printed the settings.")
      const printed = run.model.calls
        .slice(marked)
        .map((call) => result(call))
        .find((text) => text?.includes("left="))
      // The command ran, in the environment of the agent's tool, and found neither variable.
      expect(printed?.trim()).toBe("key=[] url=[] left=0")
    } finally {
      restore()
    }
  })
})

// WSL's launchers, which Novadeck's launcher passes over (they run commands in Linux).
const wslFolder = (entry: string): boolean =>
  /\\(?:Windows\\System32|Microsoft\\WindowsApps)\\?$/i.test(entry)

// On Windows without Git Bash: the sandbox's Program Files folders hold no Git, and its PATH keeps
// no folder with a bash.exe but WSL's launchers (Git's own go, as a computer without Git has none),
// so Novadeck's launcher gives pi `--tools -bash,+powershell`.
const noGit: AgentSetup = {
  ...ownPi,
  prepare: async (sandbox, model, installed, seed) => {
    const prepared = await ownPi.prepare(sandbox, model, installed, seed)
    const env = { ...sandbox.env, ...prepared }
    // Windows names it Path; one key only, as two spellings would both reach the child.
    const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
    const kept = (env[key] ?? "")
      .split(delimiter)
      .filter((entry) => wslFolder(entry) || !existsSync(join(entry, "bash.exe")))
      .join(delimiter)
    return {
      ...prepared,
      [key]: kept,
      ProgramFiles: join(sandbox.root, "Program Files"),
      "ProgramFiles(x86)": join(sandbox.root, "Program Files (x86)"),
      ProgramW6432: join(sandbox.root, "Program Files"),
    }
  },
}

describe.skipIf(!supported || process.platform !== "win32")(
  `${ownPi.name} in the tour, on Windows without Git Bash`,
  () => {
    const it = e2e.seeded({ trustedInHome: [folder] }, noGit)

    it("starts with its powershell tool in place of bash, and the lead runs a command in it", async ({
      e2e: run,
    }) => {
      const { lead, restore } = await leadOf(run, noGit)
      try {
        run.model.use(
          own((call) =>
            asked(call, "Print the service settings")
              ? { calls: [{ name: shellOf(call), input: { command: printing[shellOf(call)] } }] }
              : undefined,
          ),
          own((call) =>
            result(call)?.includes("left=") ? { text: "Printed the settings." } : undefined,
          ),
        )
        const marked = run.model.mark()
        await turn(lead, "Print the service settings", "Printed the settings.")
        const calls = run.model.calls.slice(marked)
        // Its tools: powershell, and no bash.
        expect(calls[0]!.tools).toContain("powershell")
        expect(calls[0]!.tools).not.toContain("bash")
        const printed = calls.map((call) => result(call)).find((text) => text?.includes("left="))
        expect(printed?.trim()).toBe("key=[] url=[] left=0")
      } finally {
        restore()
      }
    })
  },
)
