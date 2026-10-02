import type { AgentName } from "@novadeck/protocol"

import type { Dialect } from "../model/dialect.js"
import type { FakeModel } from "../model/server.js"
import type { Sandbox } from "../sandbox.js"

/**
 * One harness, as an end-to-end test runs it: its pinned program, pointed at the fake
 * model, in a sandbox of its own, starting straight at its prompt with NovaDeck's plugin
 * connected.
 */
export type AgentSetup = {
  readonly agent: AgentName
  /** The product's name, as a scenario names its tests: "Claude Code", "Codex", "Antigravity". */
  readonly name: string
  readonly dialect: Dialect
  /** What its first screen shows once it is at its prompt. */
  readonly banner: string | RegExp
  /**
   * Whether a session binds as soon as it is at its prompt, before any prompt: Claude Code
   * reports its session as it starts; Codex and Antigravity only with their first prompt.
   */
  readonly bindsAtReady: boolean
  /**
   * Hosts it tries through the proxy on every run, which no setting turns off: their
   * refused tunnels are expected. Any other refused tunnel is not.
   */
  readonly refused: readonly string[]
  /**
   * What the tripwire watches of the harness in the developer's home, relative to it.
   * `searched` are configuration files their own sessions rewrite as they start or run,
   * read and searched only for the sandbox's root, which only a connect or trust that
   * leaked out of the sandbox would write there. `listed` are folders whose entries'
   * names are searched for the sandbox's name. `stamped` are paths whose modification time
   * and size alone are compared, never their contents: a login, which is never read, and
   * plugin folders that change only when a plugin is installed or removed.
   */
  readonly watch: {
    readonly searched: readonly string[]
    readonly listed: readonly string[]
    readonly stamped: readonly string[]
  }
  /**
   * Seeds the harness's configuration inside the sandbox, so it starts at its own prompt
   * with no trust, onboarding, sign-in, update or key screen, for the version installed.
   * Returns what the sandbox's environment gains for it: its config home, the fake
   * model's address and the fake credential. The test's deck then connects NovaDeck's
   * plugin through the harness's own commands, with that environment, as the Connect
   * button does.
   */
  readonly prepare: (
    sandbox: Sandbox,
    model: FakeModel,
    installed: { readonly version: string },
  ) => Promise<Readonly<Record<string, string>>>
  /**
   * Finishes what only the connected plugin makes possible, before any harness starts:
   * Codex trusts NovaDeck's hooks, whose hashes are of the hooks the plugin installed.
   */
  readonly connected?: (sandbox: Sandbox, model: FakeModel) => Promise<void>
  /**
   * The hosts of the harness's real API and login, which no request may even try to
   * reach: one that does fails the test, as the fake model was bypassed.
   */
  readonly hosts?: readonly string[]
}
