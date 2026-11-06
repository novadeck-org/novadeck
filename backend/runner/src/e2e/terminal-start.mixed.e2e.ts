import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import { createDeck, poll, type Deck, type DeckTerminal } from "./deck.js"
import { describe, e2e, supported } from "./fixture.js"
import { prompted } from "./scenarios.js"

// How long a new Windows terminal takes, as numbers in this job's log (#722). A ConPTY writes
// its own setup at once, so a first chunk of output tells nothing: the times are to text on the
// screen. They are read every 100 ms or so. Nothing here fails on a slow time, as a busy runner's
// are its own; the first of each is the cold one.
const rounds = 3

const order = [claude, codex, agy]

const since = (began: number): number => Math.round(performance.now() - began)

const shows = async (terminal: DeckTerminal, text: RegExp): Promise<void> => {
  await poll(
    async () => (text.test(await terminal.screen()) ? true : undefined),
    `${terminal.handle} to show ${text}`,
    60_000,
  )
}

/** The times of one terminal opened on `deck`: `steps` wait for each mark past its first text. */
const timed = async (
  name: string,
  deck: Deck,
  command: string | undefined,
  steps: (terminal: DeckTerminal, mark: (step: string) => void) => Promise<void>,
): Promise<string> => {
  const began = performance.now()
  const terminal = await deck.open(command)
  const marks = [`open ${since(began)} ms`]
  const mark = (step: string) => marks.push(`${step} ${since(began)} ms`)
  await shows(terminal, /\S/)
  mark("first text")
  await steps(terminal, mark)
  return `${name}: ${marks.join(", ")}`
}

describe.runIf(process.platform === "win32" && supported)("a new Windows terminal", () => {
  const it = e2e(...order)

  it(
    "logs how long each shell and each agent take to draw",
    { timeout: 420_000 },
    async ({ e2e: run }) => {
      const lines: string[] = []
      const shells = [
        ["cmd", run.sandbox.env.ComSpec ?? "cmd.exe"],
        [
          "PowerShell",
          join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ],
      ] as const
      for (const [name, shell] of shells) {
        const root = mkdtempSync(join(tmpdir(), "novadeck-e2e-start-"))
        // eslint-disable-next-line no-await-in-loop -- One terminal at a time, for clean times.
        const deck = await createDeck({
          data: join(root, "data"),
          project: root,
          env: run.sandbox.env,
          shell,
        })
        try {
          for (let round = 1; round <= rounds; round++)
            lines.push(
              // eslint-disable-next-line no-await-in-loop -- As above.
              await timed(`${name} #${round}`, deck, undefined, async (terminal, mark) => {
                await shows(terminal, />\s*$/m)
                mark("prompt")
              }),
            )
        } finally {
          // eslint-disable-next-line no-await-in-loop -- As above.
          await deck.close()
          rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
        }
      }
      for (const setup of order)
        for (let round = 1; round <= rounds; round++)
          lines.push(
            // eslint-disable-next-line no-await-in-loop -- As above.
            await timed(
              `${setup.name} #${round}`,
              run.deck,
              setup.agent,
              async (terminal, mark) => {
                await terminal.reached("ready", { timeoutMs: 60_000 })
                mark("ready")
                await prompted(terminal, setup)
                mark("at its prompt")
              },
            ),
          )
      process.stdout.write(`New terminals on Windows:\n${lines.join("\n")}\n`)
    },
  )
})
