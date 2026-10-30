import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"

import { handleOrder } from "../terminals/handles.js"
import { describe, expect } from "../test.js"
import { bash, it, create } from "./integration.test-support.js"

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "bash shell integration: handles and names",
  () => {
    it("gives each session its own handles, whatever other sessions have open, and never reuses one", async ({
      shell,
    }) => {
      const manager = shell.manager()
      const other = shell.store.createSession({
        id: randomUUID(),
        projectId: shell.store.session(shell.sessionId).projectId,
        name: "Other",
      })
      const handles = async (sessionId: string, count: number) => {
        const given: string[] = []
        for (let index = 0; index < count; index += 1)
          // eslint-disable-next-line no-await-in-loop -- Created in turn, so handles follow the list.
          given.push((await create(manager, shell, { sessionId })).handle)
        return given
      }
      expect(await handles(shell.sessionId, 2)).toEqual(["moth", "fox"])
      // "moth" and "fox" being open in the first session changes nothing for the second.
      expect(await handles(other.id, 2)).toEqual(["moth", "fox"])
      // A closed terminal's word is never given again in its session.
      const closing = manager.list(shell.sessionId)[0]!
      await manager.close({ terminalId: closing.id })
      expect(closing.handle).toBe("moth")
      expect(await handles(shell.sessionId, 1)).toEqual(["owl"])
    })

    it("gives a session's words in its own shuffled order", async ({ shell }) => {
      const manager = shell.manager({ handleOrder })
      const given = [
        await create(manager, shell),
        await create(manager, shell),
        await create(manager, shell),
      ]
      expect(given.map(({ handle }) => handle)).toEqual(handleOrder(shell.sessionId).slice(0, 3))
    })

    it("names terminals by session, renames them, and tells watchers", async ({ shell }) => {
      const manager = shell.manager()
      const next = shell.watch(manager)
      const first = await create(manager, shell)
      const second = await create(manager, shell)
      expect([first.title, second.title]).toEqual(["Terminal", "Terminal"])
      const titled = await manager.create(
        {
          id: randomUUID(),
          sessionId: shell.sessionId,
          cwd: shell.home,
          cols: 80,
          rows: 24,
          title: "Docs",
        },
        "owner",
      )
      expect([first.handle, second.handle]).toEqual(["moth", "fox"])
      // A terminal given its own title still draws its handle.
      expect(titled).toMatchObject({
        title: "Docs",
        handle: "owl",
        started: true,
        command: null,
      })
      manager.rename({ terminalId: first.id, title: "API author" })
      await next((summary) => summary.id === first.id && summary.title === "API author")
      expect(shell.store.terminal(first.id)).toMatchObject({
        naming: { person: "API author" },
        handle: "moth",
      })
      // A handle isn't given twice, even once its terminal closes.
      await manager.close({ terminalId: second.id })
      expect(await create(manager, shell)).toMatchObject({
        title: "Terminal",
        handle: "crow",
      })
    })
  },
)
