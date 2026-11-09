import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked } from "./model/script.js"
import { start } from "./scenarios.js"

// A command the person runs in the harness's own shell mode (`!sleep 8`) is no turn and no
// hook tells it, yet the terminal's summary reports it as `shellCommand` while the process
// it started under the agent runs, and drops it when that process ends; the agent's
// activity is unchanged by it. The same for every harness (messaging.e2e.ts has the rule on
// parity), bound to a session or, as Codex and Antigravity are before their first prompt,
// not. Esc on a running command is left out: Claude Code and Codex kill it, Antigravity
// keeps it running, and when the kill shows differs by harness.

const seconds = 5
// Antigravity runs a command in cmd on Windows, which has no `sleep`; node is on every
// sandbox's PATH, and a command without `>` or `&` reads the same in cmd, PowerShell and sh.
const command =
  process.platform === "win32"
    ? `node -e "setTimeout(function(){},${seconds * 1000})"`
    : `sleep ${seconds}`
const needle = process.platform === "win32" ? "setTimeout" : command

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
  })
}
