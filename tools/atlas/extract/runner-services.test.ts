import { expect, test } from "vitest"

import { functionsOf, rankCalls } from "./runner-services.ts"

// The router's handlers, as they read in backend/runner/src/router.ts.
const first = (body: string, id: string, functions: string[] = []) => {
  const call = rankCalls(body, id, new Set(functions))[0]
  return call && `${call.service === null ? "" : `${call.service}.`}${call.name}`
}

test("a call named like the procedure wins, even inside a callback", () => {
  const body = `api.terminals.create.handler(async ({ input, context }) => {
        const session = store.session(input.sessionId)
        return projects.creatingIn(project.id, () =>
          terminals.create({ ...input, cwd: input.cwd ?? project.cwd }, context.session.id),
        )
      }),`
  expect(first(body, "terminals.create")).toBe("terminals.create")
})

test("a guard before the work is not the handler", () => {
  const create = `api.sessions.create.handler(({ input }) => {
        projects.ensureNotRemoving(input.projectId)
        return store.createSession(input)
      }),`
  expect(first(create, "sessions.create")).toBe("store.createSession")
  const upload = `api.terminals.upload.handler(async ({ input }) => {
        if (!terminals.place(input.terminalId)) throw new DomainError("TERMINAL_NOT_FOUND")
        return { path: await uploads.save(input) }
      }),`
  expect(first(upload, "terminals.upload")).toBe("uploads.save")
  const folder = `api.projects.folder.handler(({ input }) => {
        projects.ensureNotRemoving(input.projectId)
        return listFolder(store.project(input.projectId).cwd, input.folder)
      }),`
  expect(first(folder, "projects.folder", ["listFolder"])).toBe("listFolder")
})

test("a callback passed on is not the handler; the function whose result is returned is", () => {
  const body = `api.companions.save.handler(async ({ input }) => {
        const item = store.item(input.itemId)
        if (!item) throw new DomainError("NOT_FOUND", "Item not found")
        const run = async () => {
          const folders = await planSaveFolders(item, {
            projectFolder: (sessionId) => store.project(store.session(sessionId).projectId).cwd,
            place: (terminalId) => terminals.place(terminalId),
            planFolders: (agent) => agents.planFolders(agent),
          })
          const result = await savePlan(item, input.text, input.basedOn, folders)
          if (result.saved) return result
          const skill = item.plan ? await agents.connected(item.plan.agent) : false
          return { ...result, current: { ...result.current, skill } }
        }
      }),`
  expect(first(body, "companions.save", ["planSaveFolders", "savePlan"])).toBe("savePlan")
})

test("reads the functions the router imports by value from the runner's files", () => {
  const router = [
    'import { homedir } from "node:os"',
    'import { savePlan } from "./companions/content.js"',
    'import type { Projects } from "./workspaces/projects.js"',
    'import { listFolder, type Entry } from "./workspaces/folder.js"',
  ].join("\n")
  expect([...functionsOf(router)]).toEqual([
    ["savePlan", "backend/runner/src/companions/content.ts"],
    ["listFolder", "backend/runner/src/workspaces/folder.ts"],
  ])
})
