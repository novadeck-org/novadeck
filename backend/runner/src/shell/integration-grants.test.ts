import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { TerminalRequest } from "@novadeck/protocol"

import { describe, expect } from "../test.js"
import { bash, it, create, fakeAgent, open, show, showStandIn } from "./integration.test-support.js"

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "a team grant at an Antigravity launch from a bash terminal",
  () => {
    it("covers a teammate its lead opened with open_agent, which is led before the launch settings are written", async ({
      shell,
    }) => {
      const bin = showStandIn(shell.home)
      fakeAgent(shell.home, "agy")
      const manager = shell.manager({
        env: {
          HOME: shell.home,
          PS1: "$ ",
          PATH: `${bin}:${join(shell.home, "bin")}:${process.env.PATH}`,
        },
        install: (agent) =>
          Promise.resolve({
            env: {},
            home: shell.home,
            platform: process.platform,
            plugin: join(shell.plugins, agent),
          }),
        models: () => Promise.resolve([]),
        // The plugin counts as installed and current, as the grants require.
        narrowVerified: () => Promise.resolve(true),
      })
      const lead = await create(manager, shell)
      const { handle } = manager.get(lead.id)
      const projectId = shell.store.session(shell.sessionId).projectId
      // The person's grant for the lead's team, before the lead has any teammate.
      manager["messaging"].grants.make({
        projectId,
        workspaceSessionId: shell.sessionId,
        holder: { kind: "team", lead: handle, withLead: false },
        presets: ["push"],
        commands: [],
        repos: [{ url: "github.com/acme/shop", defaultBranch: "main", defaultFrom: "github" }],
        entryId: randomUUID(),
        proposedBy: handle,
        lifetime: "until-done",
      })
      const controller = new AbortController()
      const created: string[] = []
      const client = (async () => {
        for await (const request of manager.requests("client", controller.signal)) {
          const id = randomUUID()
          created.push(id)
          // eslint-disable-next-line no-await-in-loop -- Requests are opened in turn.
          await manager.create(
            {
              id,
              sessionId: (request as TerminalRequest).sessionId,
              cwd: request.cwd,
              cols: 100,
              rows: 20,
              ...(request.command && { command: request.command }),
              requestId: request.requestId,
            },
            "client",
          )
          manager.answerRequest({ requestId: request.requestId, terminalId: id }, "client")
        }
      })()
      try {
        const answers = (await show(shell, manager, lead.id, [
          { ...open({ agent: "agy", lead: true }), type: "open_agent" as "open" },
        ])) as { ok: boolean }[]
        expect(answers.map(({ ok }) => ok)).toEqual([true])
        expect(manager.get(created[0]!).ledBy).toBe(handle)
        // The settings the agy shim reads exist for the teammate: its grant was found at launch.
        const settings = join(shell.home, "..", "data", "shell", "narrow", `${created[0]!}.json`)
        expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
          permissions: { allow: ["command(git)"] },
        })
        expect(manager.approving.narrowed()).toEqual([manager.get(created[0]!).handle])
      } finally {
        controller.abort()
        await client
      }
    })
  },
)

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "a grant when its terminal is closed",
  () => {
    it("ends with a terminal closed after its shell exited, whose live entry is gone", async ({
      shell,
    }) => {
      const manager = shell.manager({ env: { HOME: shell.home, PS1: "$ " } })
      const lead = await create(manager, shell)
      const { handle } = manager.get(lead.id)
      const projectId = shell.store.session(shell.sessionId).projectId
      const { grants } = manager["messaging"]
      for (const holder of [
        { kind: "team" as const, lead: handle, withLead: false },
        { kind: "terminal" as const, handle },
      ])
        grants.make({
          projectId,
          workspaceSessionId: shell.sessionId,
          holder,
          presets: [],
          commands: [{ argv: ["make", "ship"], rest: false }],
          repos: [],
          entryId: randomUUID(),
          proposedBy: handle,
          lifetime: "until-done",
        })
      // The exit of its shell removed the live entry, as `exited` does.
      manager["messaging"].unregister(lead.id)
      expect(grants.list()).toHaveLength(2)
      await manager.close({ terminalId: lead.id })
      expect(grants.list()).toEqual([])
    })
  },
)
