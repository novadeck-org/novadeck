import type { WorkPreview } from "@novadeck/core/works"
import { FilePreview } from "@novadeck/items/FilePreview"
import type { Agent, Rename } from "@novadeck/items/FilePreview"
import { useEffect, useMemo, useState, type ReactNode } from "react"

import { filesOfWorks } from "../sidebar/files-works"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import {
  copyOf,
  noFiles,
  noWorks,
  ownersOf,
  previewFiles,
  sameOwners,
  sameWorks,
} from "./files-feed"
import { currentTarget, sameTarget } from "./selectors"
import type { FilePreviewRequest } from "./ui-store"

// How often an open preview is read again while an agent writes the file: the works come every
// few seconds, and a write that changes a file again leaves what the agent's status says the same.
const writingEveryMs = 2000

const noHandles: ReadonlySet<string> = new Set()

// The project window's file as it would be once the agents' work merges onto main: asks the
// backend for it and draws it with the agents' names, lighting and writes from the app. It
// shows `fallback` (the file as it is in main) until it has something to preview, and where
// the backend can't say, the file may hold secrets, or no work changes it any longer.
// Whether the window should go back to the project's own file: it points at an agent's copy in
// its worktree (main lacked the file) and the preview, read, lists no work for it any longer
// (merged, or closed), so what the window holds is about to be gone.
export const shouldRepoint = (
  request: Pick<FilePreviewRequest, "backed">,
  preview: Pick<WorkPreview, "unavailable" | "works" | "renames"> | undefined,
): boolean =>
  request.backed &&
  preview !== undefined &&
  !preview.unavailable &&
  preview.works.length === 0 &&
  preview.renames.length === 0

const Reading = ({
  request,
  fallback,
}: {
  request: FilePreviewRequest
  fallback: ReactNode
}): React.JSX.Element => {
  const { projectId, path } = request
  const { backend, commands } = useWorkspaceServices()
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
  const filesProject = useStoreSelector(
    backend.files?.state ?? noFiles,
    (state) => state.projects[projectId],
  )
  const project = useMemo(
    () => filesProject ?? filesOfWorks(projectWorks, projectId, owners),
    [filesProject, projectWorks, projectId, owners],
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
  const lit = useUiState((state) => state.filesLit)

  // What changes the preview: a work that changes the file, or lines of it, anew.
  const changed = useMemo(
    () =>
      JSON.stringify(
        previewFiles(projectWorks, projectId, path).map(({ work, file }) => [
          work.root,
          file.path,
          file.status,
          file.changedAt,
          file.added,
          file.removed,
          work.working,
        ]),
      ),
    [projectWorks, projectId, path],
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
          renamedFrom: work.renamedFrom,
          hunks: work.hunks,
        }
      }),
    [preview, owners],
  )
  // Where main has the file by now, the window goes back to it; where it still doesn't it stays.
  const repoint = shouldRepoint(request, preview)
  useEffect(() => {
    if (repoint) commands.openProjectFile(path).catch(() => {})
  }, [repoint, commands, path])
  const renames = useMemo(
    (): readonly Rename[] =>
      (preview?.renames ?? []).map((rename) => {
        const handle =
          rename.terminalId === null ? undefined : owners.get(rename.terminalId)?.handle
        return {
          label: handle === undefined ? (rename.branch ?? "worktree") : `@${handle}`,
          to: rename.to,
        }
      }),
    [preview, owners],
  )
  if (!preview || preview.unavailable || (agents.length === 0 && renames.length === 0))
    return <>{fallback}</>
  return (
    <FilePreview
      path={path}
      main={preview.main}
      agents={agents}
      lit={lit ?? noHandles}
      writing={writing}
      renames={renames}
      // The file it was renamed to has its own preview, backed by the renamer's copy where main lacks it.
      onOpen={(to) =>
        void commands
          .openProjectFile(to, { preview: true, copy: copyOf(projectWorks, projectId, to) })
          .catch(() => {})
      }
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
