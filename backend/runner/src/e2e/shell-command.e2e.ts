import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, gate } from "./model/script.js"
import { start } from "./scenarios.js"

// A command the person runs in the harness's own shell mode (`!sleep 8`) is no turn and no
// hook tells it, yet the terminal's summary reports it as `shellCommand` while the process
// it started under the terminal's shell runs, and drops it when that process ends; the agent's
// activity is unchanged by it. The same for every harness (messaging.e2e.ts has the rule on
// parity), bound to a session or, as Codex and Antigravity are before their first prompt,
// not; and when it is entered mid-turn (Claude Code and Antigravity queue it until the turn
// ends, Codex runs it at once), where it shows by the turn's end at the latest. Esc on a running command is left out: Claude Code and Codex kill it, Antigravity
// keeps it running, and when the kill shows differs by harness.

const seconds = 5
// The mid-turn case's command outlives the turn's end by a few seconds.
const longer = 8
// Antigravity runs a command in cmd on Windows, which has no `sleep`; node is on every
// sandbox's PATH, and a command without `>` or `&` reads the same in cmd, PowerShell and sh.
const sleeping = (long: number) =>
  process.platform === "win32"
    ? `node -e "setTimeout(function(){},${long * 1000})"`
    : `sleep ${long}`
const command = sleeping(seconds)
const needleOf = (long: string) => (process.platform === "win32" ? "setTimeout" : long)
const needle = needleOf(command)

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** A paste as a terminal sends it, bracketed. */
const paste = (words: string) => `\x1b[200~${words}\x1b[201~`

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    for (const bound of [false, true]) {
      it(`reports a command run in shell mode while it runs, ${bound ? "after" : "before"} the first prompt, with no change to its activity`, async ({
        e2e: run,
      }) => {
        run.model.use((call) => (asked(call, "Say hi") ? { text: "Hi there." } : undefined))
        const t = await start(run, setup)
        if (bound) {
          await t.submit("Say hi")
          await t.until("Hi there.")
          await t.reached("settled")
        }
        expect(t.summary().shellCommand).toBeNull()
        const state = t.summary().activity?.state ?? null
        const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")

        // `!` typed alone enters shell mode in all three (Antigravity only so); the command
        // is pasted, then Enter runs it.
        raw("!")
        await wait(800)
        raw(paste(command))
        await wait(800)
        const entered = Date.now()
        raw("\r")

        const seen: (string | null)[] = []
        const shell = await t.poll(
          () => {
            const found = t.summary().shellCommand
            seen.push(t.summary().activity?.state ?? null)
            return found ?? undefined
          },
          "its summary to report the shell command",
          6000,
        )
        expect(shell.command).toContain(needle)
        expect(shell.since).toBeGreaterThanOrEqual(entered - 1000)
        expect(shell.since).toBeLessThanOrEqual(Date.now())

        // It ends with its process: null soon after the command's seconds are over.
        await t.poll(
          () => {
            const now = t.summary()
            seen.push(now.activity?.state ?? null)
            return now.shellCommand === null ? true : undefined
          },
          "its summary to drop the shell command once the process ended",
          seconds * 1000 + 6000 - (Date.now() - entered),
        )
        expect(Date.now() - entered).toBeGreaterThanOrEqual((seconds - 1) * 1000)

        // No turn: never working, and the state it had before. A harness not yet bound
        // may bind as the command runs (Antigravity reports idle then), never a turn. The
        // model's calls aren't counted: Claude Code makes one of its own around a command.
        expect(seen).not.toContain("working")
        const allowed = state === null ? [null, "idle"] : [state]
        expect(seen.every((one) => allowed.includes(one))).toBe(true)
      })
    }

    it("reports a command entered while a turn works once the turn has ended, then drops it", async ({
      e2e: run,
    }) => {
      const held = gate()
      run.model.use(async (call) => {
        if (!asked(call, "Hold on")) return undefined
        await held.opened
        return { text: "Held." }
      })
      const t = await start(run, setup)
      const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
      await t.submit("Hold on")
      await t.reached("working")

      raw("!")
      await wait(800)
      raw(paste(sleeping(longer)))
      await wait(800)
      const entered = Date.now()
      raw("\r")
      await wait(1000)
      held.open()
      await t.until("Held.")

      // Codex shows it from its Enter; the others from the turn's end, a second or so after.
      const shell = await t.poll(
        () => t.summary().shellCommand ?? undefined,
        "its summary to report the shell command after the turn",
        longer * 1000,
      )
      expect(shell.command).toContain(needleOf(sleeping(longer)))
      expect(shell.since).toBeGreaterThanOrEqual(entered - 1000)

      await t.poll(
        () => (t.summary().shellCommand === null ? true : undefined),
        "its summary to drop the shell command once the process ended",
        longer * 1000 + 6000,
      )
      // The turn's activity is its own: working through it (Claude Code, which takes a
      // queued command's output as a turn of its own, stays so a while longer), then idle.
      await t.poll(
        () => (t.summary().activity?.state === "idle" ? true : undefined),
        "its agent to be idle",
        15_000,
      )
    })
  })
}
