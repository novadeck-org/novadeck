import type { WorkPreview } from "@novadeck/core/works"
import { FilePreview } from "@novadeck/items/FilePreview"
import type { Agent } from "@novadeck/items/FilePreview"
import { useEffect, useMemo, useState, type ReactNode } from "react"

import { projectPath, sourceOfWorks } from "../sidebar/source-works"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import { currentTarget, sameTarget } from "./selectors"
import { noSource, noWorks, ownersOf, sameOwners, sameWorks } from "./source-feed"
import type { FilePreviewRequest } from "./ui-store"

// How often an open preview is read again while an agent writes the file: the works come every
// few seconds, and a write that changes a file again leaves what the agent's status says the same.
const writingEveryMs = 2000

const noHandles: ReadonlySet<string> = new Set()

// The project window's file as it would be once the agents' work merges onto main: asks the
// backend for it and draws it with the agents' names, lighting and writes from the app. It
// shows `fallback` (the file as it is in main) until it has something to preview, and where
// the backend can't say, the file may hold secrets, or no work changes it any longer.
const Reading = ({
  request,
  fallback,
}: {
  request: FilePreviewRequest
  fallback: ReactNode
}): React.JSX.Element => {
  const { projectId, path } = request
  const { backend } = useWorkspaceServices()
  const works = backend.works
  // The works are followed while the preview shows.
  useEffect(() => works?.watch(), [works])
  const projectWorks = useStoreSelector(
    works?.state ?? noWorks,
    (state) => state.works.filter((work) => work.projectId === projectId),
    sameWorks,
  )
  const owners = useWorkspaceState(
    (workspace) =>
      ownersOf(workspace.projects.find((project) => project.id === projectId)?.history ?? []),
    sameOwners,
  )
  const sourced = useStoreSelector(
    backend.source?.state ?? noSource,
    (state) => state.projects[projectId],
  )
  const project = useMemo(
    () => sourced ?? sourceOfWorks(projectWorks, projectId, owners),
    [sourced, projectWorks, projectId, owners],
  )
  const writing = useMemo(
    () =>
      new Set(
        Object.entries(project?.writing ?? {}).flatMap(([handle, file]) =>
          file === path ? [handle] : [],
        ),
      ),
    [project, path],
  )
  const lit = useUiState((state) => state.sourceLit)

  // What changes the preview: a work that changes the file, or lines of it, anew.
  const changed = useMemo(
    () =>
      JSON.stringify(
        projectWorks.flatMap((work) => {
          const file =
            work.folder === undefined
              ? undefined
              : work.files.find((each) => projectPath(work.folder!, each.path) === path)
          return file
            ? [[work.root, file.status, file.changedAt, file.added, file.removed, work.working]]
            : []
        }),
      ),
    [projectWorks, path],
  )
  const [preview, setPreview] = useState<WorkPreview | undefined>()
  const writers = [...writing].toSorted().join(" ")
  useEffect(() => {
    if (!works) return
    let live = true
    // One read at a time; what came meanwhile is read once it ends.
    let busy = false
    let again = false
    const read = (): void => {
      if (busy) {
        again = true
        return
      }
      busy = true
      again = false
      works
        .preview(projectId, path)
        .then(
          (found) => {
            if (live) setPreview(found)
          },
          () => {},
        )
        .finally(() => {
          busy = false
          if (live && again) read()
        })
    }
    read()
    const timer = writers === "" ? undefined : setInterval(read, writingEveryMs)
    return () => {
      live = false
      clearInterval(timer)
    }
    // `changed` is no part of the read: a work changing the file has it read again.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- See above.
  }, [works, projectId, path, changed, writers])

  const agents = useMemo(
    (): readonly Agent[] =>
      (preview?.works ?? []).map((work) => {
        const handle = work.terminalId === null ? undefined : owners.get(work.terminalId)?.handle
        return {
          key: work.root,
          handle,
          label: handle === undefined ? (work.branch ?? "worktree") : `@${handle}`,
          status: work.status,
          changedAt: work.changedAt,
          hunks: work.hunks,
        }
      }),
    [preview, owners],
  )
  if (!preview || preview.unavailable || agents.length === 0) return <>{fallback}</>
  return (
    <FilePreview
      path={path}
      main={preview.main}
      agents={agents}
      lit={lit ?? noHandles}
      writing={writing}
    />
  )
}

// The session's project window as a preview, starting over each time a file is opened to preview.
export const FilePreviewHost = ({ fallback }: { fallback: ReactNode }): React.JSX.Element => {
  const target = useWorkspaceState(currentTarget, sameTarget)
  const request = useUiState(
    (state) => state.filePreviews[`${target.projectId}/${target.workspaceSessionId}`],
  )
  return request ? (
    <Reading key={request.opened} request={request} fallback={fallback} />
  ) : (
    <>{fallback}</>
  )
}
