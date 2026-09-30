import type { TerminalMetadata } from "../../model/types"
import { AgentOutput } from "./AgentOutput"
import { demoAgent, sampleOutput } from "./samples"

export const TerminalOutput = ({
  terminal,
  projectName,
}: {
  terminal: TerminalMetadata
  projectName: string
}): React.JSX.Element => {
  const { directory } = terminal
  const agent = demoAgent(terminal)
  if (agent)
    return (
      <AgentOutput
        agent={agent}
        directory={directory}
        planning={terminal.state === "running" && terminal.agent?.planning === true}
      />
    )
  const output = sampleOutput(terminal)
  if (output === "shell")
    return (
      <>
        <div className="terminal-meta mb-8 grid gap-x-5 gap-y-0.5 text-[11px] grid-cols-[max-content_auto] [&>span:nth-child(odd)]:text-muted">
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
        <p className="text-muted">Your branch is up to date with 'origin/main'.</p>
        <p className="output-gap">Nothing to commit, working tree clean.</p>
        <p className="output-gap">
          <span className="prompt-arrow mr-2 font-semibold">❯</span> ls
        </p>
        <p className="file-list mt-1 grid w-max max-w-full grid-cols-3 gap-x-10">
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
        <p className="text-muted">
          {">"} @{projectName}/ui dev
        </p>
        <p className="text-muted">{">"} vite</p>
        <p className="output-gap">
          <strong>VITE</strong> v7.3.6 <span className="text-muted">ready in</span> 184 ms
        </p>
        <p className="output-gap">
          Local: <span className="underline underline-offset-4">http://localhost:5173/</span>
        </p>
        <p className="text-muted">Network: use --host to expose</p>
        <p className="output-gap text-muted">09:42:16 [vite] hmr update /src/App.tsx</p>
        <p className="text-muted">09:42:18 [vite] hmr update /src/styles.css</p>
      </>
    )
  if (output === "tests")
    return (
      <>
        <p>
          <span className="prompt-arrow mr-2 font-semibold">❯</span> pnpm test --watch
        </p>
        <p className="output-gap">
          <strong>DEV</strong> v5.0.1{" "}
          <span className="text-muted">{directory.replace("~", "")}</span>
        </p>
        <div className="output-gap">
          <p>
            ✓ workspace.spec.ts <span className="text-muted">(8 tests) 24ms</span>
          </p>
          <p>
            ✓ terminal.spec.ts <span className="text-muted">(6 tests) 18ms</span>
          </p>
          <p>
            ✓ canvas.spec.ts <span className="text-muted">(4 tests) 12ms</span>
          </p>
        </div>
        <div className="test-summary mt-4 border-l-2 border-line py-1 pl-3 whitespace-pre">
          <p>
            Test Files <strong>3 passed</strong> (3)
          </p>
          <p>
            {" "}
            Tests <strong>18 passed</strong> (18)
          </p>
          <p> Duration 684ms</p>
        </div>
        <p className="output-gap">
          <span className="terminal-badge mr-1 rounded-control bg-strong px-1.5 py-0.5 text-[9px] text-white">
            PASS
          </span>{" "}
          Waiting for file changes…
        </p>
        <p className="text-muted">press h to show help, press q to quit</p>
      </>
    )
  if (output === "git")
    return (
      <>
        <p>
          <span className="prompt-arrow mr-2 font-semibold">❯</span> git log --oneline -5
        </p>
        <div className="output-gap git-log [&_span]:mr-2 [&_span]:text-muted">
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
        <p className="text-muted">Working tree clean.</p>
      </>
    )
  if (output === "logs")
    return (
      <>
        <p>
          <span className="prompt-arrow mr-2 font-semibold">❯</span> pnpm dev
        </p>
        <p className="output-gap">Runtime listening on :3000</p>
        <p className="text-muted">Watching for changes…</p>
        <div className="output-gap request-log [&_span]:mr-2 [&_span]:text-muted [&_b]:mx-2 [&_b]:font-normal">
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
        <p className="output-gap text-muted">Connection established. Listening.</p>
      </>
    )
  return (
    <>
      <p>
        <span className="prompt-arrow mr-2 font-semibold">❯</span> pnpm build
      </p>
      <p className="output-gap text-muted">vite v7.3.6 building for production…</p>
      <p>✓ 1,428 modules transformed.</p>
      <div className="output-gap">
        <p>
          dist/index.html <span className="text-muted">0.64 kB</span>
        </p>
        <p>
          dist/assets/index.css <span className="text-muted">12.81 kB</span>
        </p>
        <p>
          dist/assets/index.js <span className="text-muted">184.32 kB</span>
        </p>
      </div>
      <p className="output-gap">✓ built in 1.24s</p>
    </>
  )
}
