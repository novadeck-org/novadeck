import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { unsealed } from "../testing/sealing.js"
import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import { createDeck, poll, type Deck, type DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { prompted } from "./scenarios.js"

// How long a new Windows terminal takes, as numbers in this job's log (#722). A ConPTY writes
// its own setup at once, so a first chunk of output tells nothing: the times are to text on the
// screen, read about every 100 ms. The first of each is that program's first terminal here, not
// a cold start. No time fails this test, as a busy runner's are its own; a terminal that never
// draws does, once every number is in the log.
const rounds = 3

const order = [claude, codex, agy]

// The screen a restored terminal draws first: colours on every other cell, past what a saved
// transcript keeps (256 K characters), and a last line that says it all came.
const colourful = (): string =>
  `${Array.from({ length: 1_200 }, (_, line) =>
    Array.from({ length: 58 }, (__, cell) => `\x1b[3${1 + ((line + cell) % 6)}m#-`).join(""),
  ).join("\r\n")}\x1b[0m\r\nprinted all\r\n`

const drawn = async (terminal: DeckTerminal, text: RegExp): Promise<void> => {
  await poll(
    async () => (text.test(await terminal.screen()) ? true : undefined),
    `${terminal.handle} to show ${text}`,
    60_000,
  )
}

/** One terminal `open` gives on `deck`, timed to what `steps` wait for, logged, and closed. */
const timed = async (
  name: string,
  deck: Deck,
  open: () => Promise<DeckTerminal>,
  steps: (terminal: DeckTerminal) => Record<string, Promise<void>>,
  closing: (work: () => Promise<void>) => Promise<void> = (work) => work(),
): Promise<string | undefined> => {
  const began = performance.now()
  const marks: string[] = []
  const mark = (step: string) => marks.push(`${step} ${Math.round(performance.now() - began)} ms`)
  const failures: string[] = []
  const failed = (error: unknown) => {
    const message = (error as Error).message
    marks.push(`failed: ${message}`)
    failures.push(`${name}: ${message}`)
  }
  let terminal: DeckTerminal | undefined
  try {
    terminal = await open()
    mark("open")
    const opened = terminal
    // Each on its own, so one that comes later or never hides no other.
    await Promise.all(
      Object.entries({ "first text": drawn(opened, /\S/), ...steps(opened) }).map(([step, wait]) =>
        wait.then(() => mark(step), failed),
      ),
    )
  } catch (error) {
    failed(error)
  }
  // Each ends before the next, so none starts beside the ones before it.
  if (terminal) {
    const { id } = terminal
    await closing(() => deck.terminals.close({ terminalId: id })).catch(failed)
  }
  process.stdout.write(`New terminal, ${name}: ${marks.join(", ")}\n`)
  return failures[0]
}

describe.runIf(process.platform === "win32" && supported)("a new Windows terminal", () => {
  const it = e2e(...order)

  it(
    "logs how long each shell and each agent take to draw",
    { timeout: 600_000 },
    async ({ e2e: run }) => {
      const failures: (string | undefined)[] = []
      const toPrompt = (terminal: DeckTerminal) => ({ prompt: drawn(terminal, />\s*$/m) })
      const cmd = run.sandbox.env.ComSpec ?? "cmd.exe"
      const shells = [
        ["cmd", cmd],
        [
          "PowerShell",
          join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ],
      ] as const
      for (const [name, shell] of shells) {
        const root = join(run.sandbox.root, `start-${name}`)
        mkdirSync(root)
        // eslint-disable-next-line no-await-in-loop -- One terminal at a time, for clean times.
        const deck = await createDeck({
          data: join(root, "data"),
          project: root,
          env: run.sandbox.env,
          // As the app's do on Windows; no harness runs in these terminals.
          freshPath: true,
          shell,
        })
        try {
          for (let round = 1; round <= rounds; round++)
            failures.push(
              // eslint-disable-next-line no-await-in-loop -- As above.
              await timed(`${name} #${round}`, deck, () => deck.open(), toPrompt),
            )
        } finally {
          // eslint-disable-next-line no-await-in-loop -- As above.
          await deck.close()
        }
      }
      // A restored terminal: its earlier screen is drawn on the chain the console host's request
      // waits behind, so a long one may hold back the answer, and with it the new shell.
      const root = join(run.sandbox.root, "start-restored")
      mkdirSync(root)
      writeFileSync(join(root, "short.txt"), "printed all\r\n")
      writeFileSync(join(root, "long.txt"), colourful())
      const deck = await createDeck({
        data: join(root, "data"),
        project: root,
        env: run.sandbox.env,
        freshPath: true,
        shell: cmd,
        // `unsealed`'s, so the log can say how much was saved.
        transcriptKey: Promise.resolve(new Uint8Array(32).fill(7)),
      })
      try {
        for (const size of ["short", "long"]) {
          // eslint-disable-next-line no-await-in-loop -- One terminal at a time, for clean times.
          const earlier = await deck.open(`type ${size}.txt`)
          // eslint-disable-next-line no-await-in-loop -- As above.
          await drawn(earlier, /printed all/)
          for (let round = 1; round <= rounds; round++) {
            // eslint-disable-next-line no-await-in-loop -- As above.
            await deck.restart()
            const { id } = earlier
            const saved = unsealed(deck.store.terminal(id)?.transcript, id)?.length ?? 0
            failures.push(
              // eslint-disable-next-line no-await-in-loop -- As above.
              await timed(
                `cmd restored, ${saved} characters saved, #${round}`,
                deck,
                () => deck.restore(earlier),
                toPrompt,
                // It stays, for the next round.
                async () => {},
              ),
            )
          }
          // eslint-disable-next-line no-await-in-loop -- As above.
          await deck.terminals.close({ terminalId: earlier.id })
        }
      } finally {
        await deck.close()
      }
      for (const setup of order)
        for (let round = 1; round <= rounds; round++)
          failures.push(
            // eslint-disable-next-line no-await-in-loop -- As above.
            await timed(
              `${setup.name} #${round}`,
              run.deck,
              () => run.deck.open(setup.agent),
              (terminal) => ({
                ready: terminal.reached("ready", { timeoutMs: 60_000 }).then(() => {}),
                "at its prompt": prompted(terminal, setup),
              }),
              // It may be mid-request as it ends, which the fake model forgives only here.
              run.model.ending,
            ),
          )
      expect(failures.filter((failure) => failure !== undefined)).toEqual([])
    },
  )
})
