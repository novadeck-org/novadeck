import { ArrowLeft, FileCode2, Globe, Image, RotateCw } from "lucide-react"
import { useState } from "react"

import type {
  Artifact,
  ArtifactKind,
  FileArtifact,
  ImageArtifact,
  PageArtifact,
} from "../../model/companion"

export const kindIcons: Record<ArtifactKind, typeof Image> = {
  image: Image,
  file: FileCode2,
  page: Globe,
}

// Viewers for what an agent shows beside its terminal. Files show without highlighting,
// and a page shows as its snapshot until the pane hosts a browser.

const ImageViewer = ({ artifact }: { artifact: ImageArtifact }): React.JSX.Element => {
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
        <img src={artifact.src} alt={artifact.name} />
      </div>
    </>
  )
}

// The lines the agent pointed at, from the first one on.
const pointedLines = (artifact: FileArtifact): readonly string[] =>
  artifact.lines.slice(artifact.from - artifact.firstLine, artifact.to - artifact.firstLine + 1)

const FileViewer = ({ artifact }: { artifact: FileArtifact }): React.JSX.Element => (
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

const PageViewer = ({ artifact }: { artifact: PageArtifact }): React.JSX.Element => (
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
// pointed at, or the page in a browser frame.
export const ArtifactThumb = ({ artifact }: { artifact: Artifact }): React.JSX.Element =>
  artifact.kind === "image" ? (
    <img src={artifact.src} alt="" />
  ) : artifact.kind === "file" ? (
    <code className="peek-code">{pointedLines(artifact).join("\n")}</code>
  ) : (
    <span className="peek-page">
      <span className="peek-page-bar">
        <i />
        <i />
        <i />
      </span>
      <img src={artifact.snapshot} alt="" />
    </span>
  )

export const ArtifactViewer = ({ artifact }: { artifact: Artifact }): React.JSX.Element => (
  <div className="artifact-viewer">
    {artifact.kind === "image" ? (
      <ImageViewer artifact={artifact} />
    ) : artifact.kind === "file" ? (
      <FileViewer artifact={artifact} />
    ) : (
      <PageViewer artifact={artifact} />
    )}
  </div>
)
