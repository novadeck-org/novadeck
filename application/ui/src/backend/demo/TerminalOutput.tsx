import type { TerminalMetadata } from "../../model/types"
import { AgentOutput } from "./AgentOutput"
import { demoAgent, sampleOutput } from "./samples"

// What the dev server hot-updated since it was ready: the two it opened with, then one more
// each time it moves on. The log keeps the last few, as a screen does.
const hotUpdates = [
  "/src/App.tsx",
  "/src/styles.css",
  "/src/checkout/OrderSummary.tsx",
  "/src/cart/CartSummary.tsx",
  "/src/checkout/Checkout.tsx",
  "/src/styles.css",
  "/src/cart/CartSummary.tsx",
]
const hotUpdatesShown = 3
// The seconds between two of its updates in the log, as the clock reads them.
const hotUpdateGapS = 14

const clock = (seconds: number): string =>
  [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")

const serverLog = (beats: number): { at: string; path: string }[] =>
  Array.from({ length: 2 + beats }, (_, index) => ({
    at: clock(9 * 3600 + 42 * 60 + 16 + (index < 2 ? index * 2 : 2 + (index - 1) * hotUpdateGapS)),
    path: hotUpdates[index % hotUpdates.length]!,
  })).slice(-hotUpdatesShown)

// The files the watching tests rerun for, one each time it moves on.
const reruns = [
  { file: "src/cart/CartSummary.test.ts", tests: 5, ms: 14 },
  { file: "src/checkout/Checkout.test.ts", tests: 8, ms: 21 },
  { file: "src/checkout/OrderSummary.test.ts", tests: 6, ms: 12 },
]

export const TerminalOutput = ({
  terminal,
  projectName,
  planned = false,
  reviewing = false,
  reading,
  beats = 0,
}: {
  terminal: TerminalMetadata
  projectName: string
  // Whether the agent opened asking to plan, or reviewing still; see Opening.
  planned?: boolean
  reviewing?: boolean
  // Claude Code still reading before it asks, and when its terminal opened; see Opening.
  reading?: { readonly since: number } | undefined
  // How many times the dev server and the tests have moved on since the desk opened, as
  // the visitor demo's ambient life counts them (see visitor/ambient.ts).
  beats?: number
}): React.JSX.Element => {
  const { directory } = terminal
  const agent = demoAgent(terminal)
  if (agent)
    return (
      <AgentOutput
        agent={agent}
        directory={directory}
        planned={planned}
        reviewing={reviewing}
        reading={reading}
      />
    )
  const output = sampleOutput(terminal)
  if (output === "shell")
    return (
      <>
        <div className="terminal-meta grid grid-cols-[max-content_auto]">
          <span>Last login</span>
          <span>Tue Sep 22, 09:41:08 on ttys001</span>
          <span>Workspace</span>
          <span>{directory}</span>
        </div>
        <p className="output-gap">
          <span className="prompt-arrow mr-2 font-semibold">❯</span> git status
        </p>
        <p>
          On branch <strong>main</strong>
        </p>
        <p className="muted">Your branch is up to date with 'origin/main'.</p>
        <p className="output-gap">Nothing to commit, working tree clean.</p>
        <p className="output-gap">
          <span className="prompt-arrow mr-2 font-semibold">❯</span> ls
        </p>
        <p className="file-list mt-1 grid w-max max-w-full">
          <span>application/</span>
          <span>package.json</span>
          <span>README.md</span>
          <span>node_modules/</span>
          <span>pnpm-lock.yaml</span>
          <span>tsconfig.json</span>
        </p>
      </>
    )
  if (output === "server")
    return (
      <>
        <p>
          <span className="prompt-arrow mr-2 font-semibold">❯</span> pnpm dev
        </p>
        <p className="muted">
          {">"} @{projectName}/ui dev
        </p>
        <p className="muted">{">"} vite</p>
        <p className="output-gap">
          <strong>VITE</strong> v7.3.6 <span className="muted">ready in</span> 184 ms
        </p>
        <p className="output-gap">
          Local: <span className="demo-link">http://localhost:5173/</span>
        </p>
        <p className="muted">Network: use --host to expose</p>
        {serverLog(beats).map(({ at, path }, index) => (
          <p key={`${at}${path}`} className={index === 0 ? "output-gap muted" : "muted"}>
            {at} [vite] hmr update {path}
          </p>
        ))}
      </>
    )
  if (output === "tests")
    return (
      <>
        <p>
          <span className="prompt-arrow mr-2 font-semibold">❯</span> pnpm test --watch
        </p>
        <p className="output-gap">
          <strong>DEV</strong> v5.0.1 <span className="muted">{directory.replace("~", "")}</span>
        </p>
        <div className="output-gap">
          <p>
            ✓ workspace.spec.ts <span className="muted">(8 tests) 24ms</span>
          </p>
          <p>
            ✓ terminal.spec.ts <span className="muted">(6 tests) 18ms</span>
          </p>
          <p>
            ✓ canvas.spec.ts <span className="muted">(4 tests) 12ms</span>
          </p>
        </div>
        {beats > 0 ? <TestRerun beats={beats} /> : <TestSummary files={3} tests={18} ms={684} />}
        <p className="output-gap">
          <span className="terminal-badge mr-1 px-1.5 py-0.5 text-label">PASS</span> Waiting for
          file changes…
        </p>
        <p className="muted">press h to show help, press q to quit</p>
      </>
    )
  if (output === "git")
    return (
      <>
        <p>
          <span className="prompt-arrow mr-2 font-semibold">❯</span> git log --oneline -5
        </p>
        <div className="output-gap git-log [&_span]:mr-2">
          <p>
            <span>e9a4c21</span> refine workspace layout
          </p>
          <p>
            <span>82b6f09</span> add terminal sessions
          </p>
          <p>
            <span>7d1a308</span> simplify navigation
          </p>
          <p>
            <span>c4f8e62</span> set up design tokens
          </p>
          <p>
            <span>3a9b715</span> initial commit
          </p>
        </div>
        <p className="output-gap">
          <span className="prompt-arrow mr-2 font-semibold">❯</span> git status --short
        </p>
        <p className="muted">Working tree clean.</p>
      </>
    )
  if (output === "logs")
    return (
      <>
        <p>
          <span className="prompt-arrow mr-2 font-semibold">❯</span> pnpm dev
        </p>
        <p className="output-gap">Runtime listening on :3000</p>
        <p className="muted">Watching for changes…</p>
        <div className="output-gap request-log [&_span]:mr-2 [&_b]:mx-2 [&_b]:font-normal">
          <p>
            <span>09:41:02</span> GET /api/health <b>200</b> 2ms
          </p>
          <p>
            <span>09:41:04</span> GET /api/sessions <b>200</b> 4ms
          </p>
          <p>
            <span>09:41:04</span> WS /terminal <b>101</b> 1ms
          </p>
          <p>
            <span>09:42:10</span> GET /api/health <b>200</b> 1ms
          </p>
          <p>
            <span>09:42:16</span> GET /api/sessions <b>200</b> 3ms
          </p>
        </div>
        <p className="output-gap muted">Connection established. Listening.</p>
      </>
    )
  return (
    <>
      <p>
        <span className="prompt-arrow mr-2 font-semibold">❯</span> pnpm build
      </p>
      <p className="output-gap muted">vite v7.3.6 building for production…</p>
      <p>✓ 1,428 modules transformed.</p>
      <div className="output-gap">
        <p>
          dist/index.html <span className="muted">0.64 kB</span>
        </p>
        <p>
          dist/assets/index.css <span className="muted">12.81 kB</span>
        </p>
        <p>
          dist/assets/index.js <span className="muted">184.32 kB</span>
        </p>
      </div>
      <p className="output-gap">✓ built in 1.24s</p>
    </>
  )
}

const TestSummary = ({
  files,
  tests,
  ms,
}: {
  files: number
  tests: number
  ms: number
}): React.JSX.Element => (
  <div className="test-summary mt-4 py-1 pl-3 whitespace-pre">
    <p>
      Test Files <strong>{files} passed</strong> ({files})
    </p>
    <p>
      {" "}
      Tests <strong>{tests} passed</strong> ({tests})
    </p>
    <p> Duration {ms}ms</p>
  </div>
)

// The tests watching the files, rerun for the last one that changed: all still pass.
const TestRerun = ({ beats }: { beats: number }): React.JSX.Element => {
  const { file, tests, ms } = reruns[(beats - 1) % reruns.length]!
  return (
    <>
      <p className="output-gap">
        <strong>RERUN</strong>{" "}
        <span className="muted">
          {file} x{beats}
        </span>
      </p>
      <p className="output-gap">
        ✓ {file.split("/").at(-1)}{" "}
        <span className="muted">
          ({tests} tests) {ms}ms
        </span>
      </p>
      <TestSummary files={1} tests={tests} ms={ms + 40 + (beats % 3) * 7} />
    </>
  )
}
