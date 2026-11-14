import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"

import { handleOrder } from "../terminals/handles.js"
import { describe, expect } from "../test.js"
import { bash, it, create } from "./integration.test-support.js"

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "bash shell integration: handles and names",
  () => {
    it("gives a project's sessions different handles, and a closed terminal's word rests", async ({
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
      // Handles are the project's: "moth" and "fox" open in the first session are not given
      // in the second.
      expect(await handles(other.id, 2)).toEqual(["owl", "crow"])
      // A closed terminal's word rests an hour, in either session.
      const closing = manager.list(shell.sessionId)[0]!
      await manager.close({ terminalId: closing.id })
      expect(closing.handle).toBe("moth")
      expect(await handles(shell.sessionId, 1)).toEqual(["kite"])
      expect(await handles(other.id, 1)).toEqual(["raven"])
    })

    it("gives a closed terminal's handle to a new terminal once its cooldown has passed, the one freed first", async ({
      shell,
    }) => {
      const manager = shell.manager({
        handleOrder: () => ["moth", "fox", "owl"],
        handleCooldown: 0,
      })
      const [moth, fox, owl] = [
        await create(manager, shell),
        await create(manager, shell),
        await create(manager, shell),
      ]
      expect([moth.handle, fox.handle, owl.handle]).toEqual(["moth", "fox", "owl"])
      await manager.close({ terminalId: fox.id })
      await manager.close({ terminalId: moth.id })
      // Freed first, given first; and the new terminal lists after the older owl.
      expect((await create(manager, shell)).handle).toBe("fox")
      expect((await create(manager, shell)).handle).toBe("moth")
      expect(manager.list(shell.sessionId).map(({ handle }) => handle)).toEqual([
        "owl",
        "fox",
        "moth",
      ])
    })

    it("holds a closed terminal's handle for an hour by default, and gives the next letter round", async ({
      shell,
    }) => {
      const manager = shell.manager({ handleOrder: () => ["moth"] })
      const moth = await create(manager, shell)
      await manager.close({ terminalId: moth.id })
      expect((await create(manager, shell)).handle).toBe("mothz")
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
      // A handle isn't given again at once, even once its terminal closes.
      await manager.close({ terminalId: second.id })
      expect(await create(manager, shell)).toMatchObject({
        title: "Terminal",
        handle: "crow",
      })
    })
  },
)
