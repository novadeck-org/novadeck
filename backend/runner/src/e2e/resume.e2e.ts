import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { Install } from "@novadeck/harness-core/harness"

import { harnesses } from "../harnesses/registry.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked } from "./model/script.js"
import { prompted, replies, turn } from "./scenarios.js"

// How a harness keeps a conversation, and what resuming it does (History pane): a harness
// release that moves its files, or resumes differently, fails here. Each harness has its
// real conversation made through the fake model, and resumed in a terminal of its own.

/** Where each harness keeps a conversation, under its home, as a path with `/` for the id. */
const layouts: { readonly [agent: string]: RegExp } = {
  claude: /(?:^|\/)projects\/[^/]+\/<id>\.jsonl$/,
  codex: /(?:^|\/)sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]*-<id>\.jsonl(?:\.zst)?$/,
  agy: /(?:^|\/)conversations\/<id>\.db$/,
}

const resumeCapMs = 30_000

/** Every path under `root`, relative to it with `/`. */
const walk = (root: string): string[] => {
  const out: string[] = []
  const go = (dir: string) => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      out.push(relative(root, full).replaceAll("\\", "/"))
      try {
        if (statSync(full).isDirectory()) go(full)
      } catch {
        // Gone between the two calls: not in the listing.
      }
    }
  }
  go(root)
  return out
}

for (const setup of setups) {
  describe.skipIf(!supported)(`resuming a conversation in ${setup.name}`, () => {
    const it = e2e(setup)
    const harness = harnesses[setup.agent]
    const sep = process.platform === "win32" ? "&" : ";"

    it("finds it where the harness keeps it, resumes it, and tells a missing one", async ({
      e2e: run,
    }) => {
      const install: Install = {
        env: run.sandbox.env,
        home: run.sandbox.home,
        platform: process.platform,
        plugin: "",
      }
      run.model.use(
        replies("Remember the word heron", "Heron noted."),
        replies("Which word", "The word was heron."),
      )
      const opened = new Set<string>()
      const open = async (command: string) => {
        const terminal = await run.deck.open(command)
        opened.add(terminal.id)
        return terminal
      }
      // A conversation in the project holding the word, left by `/exit`.
      const make = async (): Promise<string> => {
        const terminal = await open(setup.agent)
        await terminal.reached("ready", { timeoutMs: 60_000 })
        await prompted(terminal, setup)
        await turn(terminal, "Remember the word heron", "Heron noted.")
        const id = (await terminal.detail()).sessionId
        if (!id) throw new Error("no session bound after the first prompt")
        await terminal.submit("/exit")
        await terminal.poll(
          () => (terminal.summary().agent === null ? true : undefined),
          "the agent to leave after /exit",
          30_000,
        )
        return id
      }
      // What the harness says of a resume of `id` in a terminal typing `command`: its first
      // answer other than waiting, or waiting once the cap has passed.
      const settle = async (terminal: DeckTerminal, id: string) => {
        const until = Date.now() + resumeCapMs
        let readySince: number | undefined
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- Polled one reading at a time.
          const sessionId = (await terminal.detail()).sessionId ?? null
          const state = harness.launch.resumed(id, {
            sessionId,
            ready: terminal.summary().ready !== null,
            readyMs:
              terminal.summary().ready !== null ? Date.now() - (readySince ??= Date.now()) : 0,
          })
          if (state !== "waiting" || Date.now() > until) return state
          // eslint-disable-next-line no-await-in-loop -- Same.
          await sleep(100)
        }
      }
      const resume = (id: string) => harness.launch.resume!(id).join(" ")

      // The files: where the harness keeps the conversation, and what the check says of them.
      const id = await make()
      const layout = new RegExp(layouts[setup.agent]!.source.replace("<id>", id))
      expect(
        walk(run.sandbox.home).filter((path) => layout.test(path)),
        `a file of ${setup.name} for ${id} where it keeps conversations`,
      ).not.toEqual([])
      expect(await harness.conversation(install, id)).toBe("found")
      expect(await harness.conversation(install, randomUUID())).toBe("gone")

      // A resume that works: the sign the harness gives, the same session and what it held.
      const resumed = await open(resume(id))
      expect(await settle(resumed, id)).toBe("worked")
      await resumed.reached("ready", { timeoutMs: 30_000 })
      await prompted(resumed, setup, 30_000)
      const before = run.model.mark()
      await resumed.prompt("Which word")
      const call = await run.model.waitFor((one) => !one.side && asked(one, "Which word"), {
        after: before,
        timeoutMs: 30_000,
      })
      await resumed.until("The word was heron.", 30_000)
      expect(call.turns.some((one) => one.text.includes("Remember the word heron"))).toBe(true)
      expect((await resumed.detail()).sessionId).toBe(id)
      await resumed.submit("/exit")
      await resumed.poll(
        () => (resumed.summary().agent === null ? true : undefined),
        "the agent to leave after /exit",
        30_000,
      )

      // From another folder: the resume's own words keep Codex's working-directory question away.
      const elsewhere = join(run.sandbox.root, "elsewhere")
      mkdirSync(elsewhere, { recursive: true })
      if (setup.agent === "codex") {
        const moved = await open(`cd "${elsewhere}" ${sep} ${resume(id)}`)
        expect(await settle(moved, id)).toBe("worked")
        expect(await moved.screen()).not.toMatch(/Working directory|Session = latest cwd/)
      }

      // An id that never existed: Claude Code and Codex exit, Antigravity starts a new
      // conversation without a word, so none of them gives the sign of a resume that worked.
      const never = randomUUID()
      const missing = await open(resume(never))
      expect(await settle(missing, never)).not.toBe("worked")
      if (setup.agent === "agy") expect(await settle(missing, never)).toBe("failed")

      // A conversation whose file is gone: the check says so, and a resume does not work.
      const lost = await make()
      const store = /(?:^|\/)(?:projects|sessions|conversations)\//
      for (const path of walk(run.sandbox.home))
        if (store.test(path) && path.includes(lost))
          rmSync(join(run.sandbox.home, path), { recursive: true, force: true })
      expect(await harness.conversation(install, lost)).toBe("gone")
      const gone = await open(resume(lost))
      expect(await settle(gone, lost)).not.toBe("worked")

      await Promise.all(
        [...opened].map((terminalId) => run.deck.terminals.close({ terminalId }).catch(() => {})),
      )
    })
  })

  // Claude Code resumed in another folder names that folder's project in its hooks, and goes
  // on writing the transcript where the session began (2.1.319); Codex and Antigravity keep a
  // conversation by its id alone. A folder inside the project, trusted with it.
  const inside = "notes"
  describe.skipIf(!supported)(`resuming a conversation in ${setup.name} from another folder`, () => {
    const it = e2e.seeded({ trustedInside: [inside] }, setup)
    const harness = harnesses[setup.agent]
    const sep = process.platform === "win32" ? "&" : ";"

    it("serves its chat from where it began, the turns before and after", async ({ e2e: run }) => {
      run.model.use(
        replies("Remember the word kestrel", "Kestrel noted."),
        replies("Which bird", "The bird was kestrel."),
      )
      const first = await run.deck.open(setup.agent)
      await first.reached("ready", { timeoutMs: 60_000 })
      await prompted(first, setup)
      await turn(first, "Remember the word kestrel", "Kestrel noted.")
      const id = (await first.detail()).sessionId
      if (!id) throw new Error("no session bound after the first prompt")
      await first.submit("/exit")
      await first.poll(
        () => (first.summary().agent === null ? true : undefined),
        "the agent to leave after /exit",
        30_000,
      )

      const elsewhere = join(run.sandbox.project, inside)
      mkdirSync(elsewhere, { recursive: true })
      const resume = harness.launch.resume!(id).join(" ")
      const moved = await run.deck.open(`cd "${elsewhere}" ${sep} ${resume}`)
      await moved.reached("ready", { timeoutMs: 30_000 })
      await prompted(moved, setup, 30_000)
      await turn(moved, "Which bird", "The bird was kestrel.")
      expect((await moved.detail()).sessionId).toBe(id)
      await moved.poll(
        async () => {
          const texts = (await moved.transcript()).map((item) => item.text)
          const said = (words: string) => texts.some((text) => text.includes(words))
          return said("Remember the word kestrel") && said("The bird was kestrel.")
            ? true
            : undefined
        },
        "the chat to serve the turns before and after the resume",
        30_000,
      )
    })
  })
}
