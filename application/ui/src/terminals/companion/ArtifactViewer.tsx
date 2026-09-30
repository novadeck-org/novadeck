import { ArrowLeft, FileCode2, Globe, Image, RotateCw } from "lucide-react"
import { useState } from "react"

import type { ArtifactContent, ArtifactKind } from "../../model/companion"
import type { Shown } from "./pane"
import type { ArtifactLoad } from "./state"

type ImageContent = Extract<ArtifactContent, { kind: "image" }>
type FileContent = Extract<ArtifactContent, { kind: "file" }>
type PageContent = Extract<ArtifactContent, { kind: "page" }>

export const kindIcons: Record<ArtifactKind, typeof Image> = {
  image: Image,
  file: FileCode2,
  page: Globe,
}

// Viewers for what an agent shows beside its terminal. Files show without highlighting,
// and a page shows as its snapshot until the pane hosts a browser.

const ImageViewer = ({
  artifact,
  content,
}: {
  artifact: Shown
  content: ImageContent
}): React.JSX.Element => {
  const [actual, setActual] = useState(false)
  return (
    <>
      <div className="artifact-meta">
        <code>{artifact.name}</code>
        <span>{artifact.detail}</span>
        <span className="artifact-meta-push" />
        <div className="artifact-zoom" role="group" aria-label="Zoom">
          <button aria-pressed={!actual} onClick={() => setActual(false)}>
            Fit
          </button>
          <button aria-pressed={actual} onClick={() => setActual(true)}>
            100%
          </button>
        </div>
      </div>
      <div className="artifact-image" data-actual={actual}>
        <img src={content.src} alt={artifact.name} />
      </div>
    </>
  )
}

// The lines the agent pointed at, from the first one on.
const pointedLines = (file: FileContent): readonly string[] =>
  file.lines.slice(file.from - file.firstLine, file.to - file.firstLine + 1)

const FileViewer = ({ content: artifact }: { content: FileContent }): React.JSX.Element => (
  <>
    <div className="artifact-meta">
      <code>{artifact.path}</code>
      <span>
        lines {artifact.from}–{artifact.to} · read-only
      </span>
    </div>
    <div className="artifact-code" role="region" aria-label={artifact.path} tabIndex={0}>
      {artifact.lines.map((line, index) => {
        const number = artifact.firstLine + index
        return (
          <div key={number} data-pointed={number >= artifact.from && number <= artifact.to}>
            <span aria-hidden="true">{number}</span>
            <span>{line}</span>
          </div>
        )
      })}
    </div>
  </>
)

const PageViewer = ({ content: artifact }: { content: PageContent }): React.JSX.Element => (
  <div className="artifact-browser">
    <div className="artifact-browser-bar">
      <button aria-label="Back">
        <ArrowLeft size={13} />
      </button>
      <button aria-label="Reload">
        <RotateCw size={13} />
      </button>
      <span className="artifact-url">{artifact.url}</span>
    </div>
    <img className="artifact-page" src={artifact.snapshot} alt={`${artifact.url} as shown`} />
  </div>
)

// A small picture of an artifact, for a peek: the image itself, the lines the agent
// pointed at, or the page in a browser frame. Blank until it loads.
export const ArtifactThumb = ({ load }: { load: ArtifactLoad }): React.JSX.Element | null => {
  if (load.status !== "ready") return null
  const { content } = load
  return content.kind === "image" ? (
    <img src={content.src} alt="" />
  ) : content.kind === "file" ? (
    <code className="peek-code">{pointedLines(content).join("\n")}</code>
  ) : (
    <span className="peek-page">
      <span className="peek-page-bar">
        <i />
        <i />
        <i />
      </span>
      <img src={content.snapshot} alt="" />
    </span>
  )
}

export const ArtifactViewer = ({
  artifact,
  load,
}: {
  artifact: Shown
  load: ArtifactLoad
}): React.JSX.Element => (
  <div className="artifact-viewer" aria-busy={load.status === "loading"}>
    {load.status === "loading" ? (
      <div className="artifact-status" />
    ) : load.status === "failed" ? (
      <div className="artifact-status">Couldn't load {artifact.name}.</div>
    ) : load.content.kind === "image" ? (
      <ImageViewer artifact={artifact} content={load.content} />
    ) : load.content.kind === "file" ? (
      <FileViewer content={load.content} />
    ) : (
      <PageViewer content={load.content} />
    )}
  </div>
)
