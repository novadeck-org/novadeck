import { execFileSync } from "node:child_process"
import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { tourBriefMark } from "../messaging/messages.js"
import { tourMarker } from "../tour/folder.js"
import { tourWrites } from "../tour/launch.js"
import { setups } from "./agents/index.js"
import { poll } from "./deck.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { asked, tool, type Call } from "./model/script.js"
import { deliveries, own, prompted, result, through } from "./scenarios.js"

// Novadeck's tour (docs/tour.md), the runner's side of it, the same for every harness (see
// messaging.e2e.ts for the rule on parity): `tour.prepare` readies its folder and the line
// that starts the agent there; the client opens a project and a terminal with it; a
// harness that takes no start line on its command line (Antigravity) is given it once its
// agent has bound, by `tour.brief`. The model is a script: it follows the brief's first
// step, calling `describe` as lead.md says, and greets.

// What the brief asks its agent to describe itself as.
const title = "Tour lead"
const summary = "Leads Novadeck's tour"

// The tour's folder, as the sandbox's home holds it.
const folder = join(".novadeck", "tour")

// Whether the call is the model's first look at the lead's brief, which every harness takes as
// Novadeck's notice.
const startsTour = (call: Call): boolean =>
  !call.side &&
  asked(call, "brief for Novadeck") &&
  deliveries(call).some((one) => one.from === "novadeck" && one.text.startsWith(tourBriefMark))

const lead = [
  own((call) => {
    const describeTool = tool(call, "describe")
    return describeTool && startsTour(call)
      ? { calls: [{ name: describeTool, input: { title, summary } }] }
      : undefined
  }),
  own((call) =>
    result(call)?.includes("Described this terminal") ? { text: "The tour has begun." } : undefined,
  ),
]

// The model Codex's cache lists in these runs, a "luna" as the tour's cheapest pick.
const luna = "gpt-e2e-luna"

for (const setup of setups) {
  // Codex lists its models in a cache of its home, which a sandbox's has none of until it
  // is written, as the first run of a real one does; the tour refuses without it.
  const cache = (run: E2E) => join(run.sandbox.env.CODEX_HOME ?? "", "models_cache.json")
  const prepare = async (run: E2E) => {
    if (setup.agent === "codex")
      await writeFile(
        cache(run),
        JSON.stringify({
          models: [
            {
              slug: "gpt-e2e-big",
              visibility: "list",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
            },
            {
              slug: luna,
              visibility: "list",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
            },
          ],
        }),
      )
    return run.deck.tour.prepare(setup.agent)
  }
  describe.skipIf(!supported)(setup.name, () => {
    // The harnesses that ask about a folder they don't know are told this one is trusted:
    // the person answers that question themselves. Codex isn't, as it asks of git folders alone.
    const it = e2e.seeded({ trustedInHome: [folder] }, setup)

    it("readies the tour's folder and a launch line on the cheapest model, with write flags for this launch only", async ({
      e2e: run,
    }) => {
      const prepared = await prepare(run)

      expect(prepared.directory).toBe(join(run.sandbox.home, folder))
      expect(prepared.removed).toEqual([])
      expect(prepared.brief).toBe("doorbell")
      // The program first, then its options, then (where it takes one) the start line last.
      const [program] = prepared.command.split(" ")
      expect(program).toBe(setup.agent)
      expect(prepared.command).toContain(tourWrites[setup.agent].join(" "))
      if (setup.agent === "claude") {
        expect(prepared.model).toBe("haiku")
        expect(prepared.command).toContain("--model haiku")
        expect(prepared.command).toContain("--permission-mode acceptEdits")
      }
      if (setup.agent === "agy") {
        expect(prepared.model).toBe("gemini-3.8-flash-low")
        expect(prepared.command).toContain("--model gemini-3.8-flash-low")
        expect(prepared.command).toContain("--mode accept-edits")
      }
      if (setup.agent === "codex")
        expect(prepared.command).toContain(
          "--sandbox workspace-write --ask-for-approval on-request",
        )
      // No prompt on the line for any harness: its brief is rung to it once it is up.
      expect(prepared.brief).toBe("doorbell")
      expect(prepared.command).not.toMatch(/Novadeck|AGENTS\.md/)

      // Its folder: the two files a harness loads by itself hold no role and no step (the lead's
      // script is sent to it as a notice); a Claude Code file imports them; the marker.
      expect(await readdir(prepared.directory)).not.toContain("lead.md")
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        // eslint-disable-next-line no-await-in-loop -- Two small files.
        const loaded = await readFile(join(prepared.directory, name), "utf8")
        expect(loaded).not.toMatch(/open_agent|describe|Steps|lead agent/)
      }
      expect(await readFile(join(prepared.directory, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n")
      // A tiny git repo on main with one commit by the tour's own name, the marker kept out of it.
      expect((await readdir(prepared.directory)).toSorted()).toEqual(
        [
          ".claude",
          ".git",
          ".novadeck-tour",
          "AGENTS.md",
          "CLAUDE.md",
          "README.md",
          "split.js",
        ].toSorted(),
      )
      const gitIn = (...args: string[]) =>
        execFileSync("git", ["-C", prepared.directory, ...args], {
          encoding: "utf8",
        }).trim()
      expect(gitIn("branch", "--show-current")).toBe("main")
      expect(gitIn("log", "--format=%an <%ae>")).toBe("Novadeck tour <tour@novadeck.invalid>")
      expect(gitIn("status", "--porcelain")).toBe("")
      expect(gitIn("ls-files")).not.toContain(".novadeck-tour")
      await expect(readFile(join(prepared.directory, tourMarker), "utf8")).resolves.toContain(
        "Novadeck's tour",
      )
      // Reseeded each time: what a run left in it is gone.
      await prepare(run)
    })

    it("starts its agent on the tour, which describes itself as the tour's lead", async ({
      e2e: run,
    }) => {
      run.model.use(...lead)
      const calls = run.model.mark()
      const prepared = await prepare(run)

      const terminal = await run.deck.openAt(prepared.directory, prepared.command)
      // What the harness's process was started with, while it runs: only on Linux, as the runner
      // reads no foreground process's command line on Windows or macOS
      // (`foregroundProcess.argv` is null there). There the agent binding, its greeting and no
      // usage error on screen show it took them.
      const argv =
        process.platform !== "linux"
          ? undefined
          : await poll(
              () => {
                const words = terminal.summary().process?.argv?.join(" ")
                return words?.includes(tourWrites[setup.agent][0]!) ? words : undefined
              },
              `${terminal.handle}'s ${setup.name} to start`,
              30_000,
            )

      {
        // Plain, with nothing yet to say: its agent is rung the brief once it has bound.
        await terminal.reached("ready", { timeoutMs: 60_000 })
        await prompted(terminal, setup)
        await poll(
          () => {
            try {
              run.deck.tour.brief(terminal.id)
              return true
            } catch {
              return undefined
            }
          },
          `${terminal.handle}'s agent to take the tour's brief`,
          30_000,
        )
      }
      const first = await run.model.waitFor(startsTour, { after: calls, timeoutMs: 60_000 })
      // Novadeck's notice, delivered once its prompt shows and its tools are listed: the whole
      // script, whose first step the model follows, as an agent's task.
      const notice = deliveries(first).find((one) => one.from === "novadeck")
      expect(notice?.text).toContain("## Steps")
      expect(notice?.text).toContain("fix-tip")
      expect(notice?.text).toContain("bill splitter with two bugs")
      // The brief's own first step: the call to `describe`, and its greeting.
      await terminal.until("The tour has begun.", 60_000)
      await through(terminal, ["settled"])
      expect(terminal.summary()).toMatchObject({
        title,
        titleSource: { kind: "agent", by: terminal.handle },
      })

      // Started as the line says: the harness runs with the tour's write flags, which it
      // took (no usage error), with no question about the folder on its screen.
      if (argv !== undefined) {
        expect(argv).toContain(tourWrites[setup.agent].join(" "))
        if (setup.agent === "codex")
          expect(argv).toContain(`--model ${luna} -c model_reasoning_effort=low`)
      }
      expect(terminal.summary().agent).toBe(setup.agent)
      const shown = await terminal.screen()
      expect(shown).not.toMatch(
        /trust (this|the contents)|unexpected argument|unknown option|error:/i,
      )
      expect(shown).toContain("The tour has begun.")
    })

    it("removes the first run's project and closes its terminal when the tour starts again", async ({
      e2e: run,
    }) => {
      run.model.use(...lead)
      const first = await prepare(run)
      const opened = await run.deck.openAt(first.directory, first.command)
      const project = run.deck.store.projects().find(({ cwd }) => cwd === first.directory)
      expect(project).toBeDefined()
      expect(run.deck.terminals.get(opened.id).exit).toBeNull()

      const second = await prepare(run)

      expect(second.removed).toEqual([project!.id])
      expect(second.directory).toBe(first.directory)
      expect(run.deck.store.projects().some(({ id }) => id === project!.id)).toBe(false)
      expect(() => run.deck.terminals.get(opened.id)).toThrow(
        expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
      )
      await expect(readFile(join(second.directory, tourMarker), "utf8")).resolves.toBeTruthy()
    })

    if (setup.agent === "codex")
      it("refuses to start with Codex before it has listed its models, leaving the folder as it is", async ({
        e2e: run,
      }) => {
        const { directory } = await prepare(run)
        await writeFile(join(directory, "kept.txt"), "left by the last run")
        await rm(cache(run), { force: true })

        await expect(run.deck.tour.prepare(setup.agent)).rejects.toMatchObject({
          code: "MODELS_UNLISTED",
        })

        await expect(readFile(join(directory, "kept.txt"), "utf8")).resolves.toBe(
          "left by the last run",
        )
      })
  })
}
