import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import type { ArtifactContent } from "../../model/companion"
import { isMarkdown } from "./artifact-icons"
import { DocumentViewer } from "./DocumentViewer"
import type { HighlightedLine } from "./highlight"
import type { Shown } from "./pane"
import { headingsOf, titleOf } from "./plan-text"
import type { ArtifactLoad } from "./use-panes"
import { createWebview, type WebviewElement } from "./webview"

type ImageContent = Extract<ArtifactContent, { kind: "image" }>
type FileContent = Extract<ArtifactContent, { kind: "file" }>
type PageContent = Extract<ArtifactContent, { kind: "page" }>

// Viewers for what an agent shows beside its terminal. Files show as plain text at
// once, then highlighted when their language is one NovaDeck knows (see ./highlight.ts);
// a markdown file reads as a document instead, formatted as a plan is.
// A page loads live where the backend's host allows, in Electron's <webview>, which the
// desktop app locks down (no Node, its own session, http(s) only; see ./webview.ts);
// elsewhere it's a link to open in the browser, with a snapshot when the backend has
// one.

// What the place showing an artifact offers for it, at the end of its viewer's header.
type Actions = { actions?: ReactNode }

const ImageViewer = ({
  artifact,
  content,
  actions,
}: Actions & {
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
        {actions}
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

// The file's lines highlighted, once its parser has loaded; null until then, or for a
// language NovaDeck doesn't highlight.
const useHighlighted = (file: FileContent): readonly HighlightedLine[] | null => {
  const [highlighted, setHighlighted] = useState<{
    readonly of: FileContent
    readonly lines: readonly HighlightedLine[] | null
  } | null>(null)
  useEffect(() => {
    let current = true
    import("./highlight")
      .then(({ highlightLines }) => highlightLines(file.path, file.lines))
      .then(
        (lines) => {
          if (current) setHighlighted({ of: file, lines })
        },
        // Plain text is the fallback when a parser can't load.
        () => undefined,
      )
    return () => {
      current = false
    }
  }, [file])
  return highlighted?.of === file ? highlighted.lines : null
}

const FileViewer = ({
  content: artifact,
  actions,
}: Actions & { content: FileContent }): React.JSX.Element => {
  const highlighted = useHighlighted(artifact)
  return (
    <>
      <div className="artifact-meta">
        <code>{artifact.path}</code>
        <span>
          lines {artifact.from}–{artifact.to} · read-only
        </span>
        {actions && <span className="artifact-meta-push" />}
        {actions}
      </div>
      <div className="artifact-code" role="region" aria-label={artifact.path} tabIndex={0}>
        {artifact.lines.map((line, index) => {
          const number = artifact.firstLine + index
          return (
            <div key={number} data-pointed={number >= artifact.from && number <= artifact.to}>
              <span aria-hidden="true">{number}</span>
              <span>
                {highlighted?.[index]?.map((run) =>
                  run.classes ? (
                    <span key={run.from} className={run.classes}>
                      {run.text}
                    </span>
                  ) : (
                    run.text
                  ),
                ) ?? line}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}

// Where the page is, and where it can go.
type Place = { readonly url: string; readonly back: boolean; readonly forward: boolean }

const OpenInBrowser = ({ url }: { url: string }): React.JSX.Element => (
  // The desktop app opens a new window's http(s) address in the person's browser.
  <a className="artifact-open" href={url} target="_blank" rel="noreferrer">
    <ExternalLink size={13} aria-hidden="true" />
    Open in browser
  </a>
)

const LivePage = ({ url, actions }: Actions & { url: string }): React.JSX.Element => {
  const frame = useRef<HTMLDivElement>(null)
  const view = useRef<WebviewElement | null>(null)
  const [place, setPlace] = useState<Place>({ url, back: false, forward: false })
  useEffect(() => {
    const element = createWebview(url)
    view.current = element
    const update = (): void => {
      try {
        setPlace({
          url: element.getURL(),
          back: element.canGoBack(),
          forward: element.canGoForward(),
        })
      } catch {
        // Not attached yet: dom-ready updates it.
      }
    }
    const events = ["dom-ready", "did-navigate", "did-navigate-in-page", "did-stop-loading"]
    for (const event of events) element.addEventListener(event, update)
    frame.current?.append(element)
    return () => {
      for (const event of events) element.removeEventListener(event, update)
      element.remove()
      view.current = null
    }
  }, [url])
  return (
    <div className="artifact-browser" data-live="">
      <div className="artifact-browser-bar">
        <button aria-label="Back" disabled={!place.back} onClick={() => view.current?.goBack()}>
          <ArrowLeft size={13} />
        </button>
        <button
          aria-label="Forward"
          disabled={!place.forward}
          onClick={() => view.current?.goForward()}
        >
          <ArrowRight size={13} />
        </button>
        <button aria-label="Reload" onClick={() => view.current?.reload()}>
          <RotateCw size={13} />
        </button>
        <span className="artifact-url">{place.url}</span>
        <OpenInBrowser url={place.url} />
        {actions}
      </div>
      <div ref={frame} className="artifact-webview-frame" />
    </div>
  )
}

const PageViewer = ({
  content: artifact,
  actions,
}: Actions & { content: PageContent }): React.JSX.Element =>
  artifact.live ? (
    <LivePage url={artifact.url} actions={actions} />
  ) : (
    <div className="artifact-browser">
      <div className="artifact-browser-bar">
        <span className="artifact-url">{artifact.url}</span>
        <OpenInBrowser url={artifact.url} />
        {actions}
      </div>
      {artifact.snapshot ? (
        <img className="artifact-page" src={artifact.snapshot} alt={`${artifact.url} as shown`} />
      ) : (
        <div className="artifact-status">This page opens in your browser.</div>
      )}
    </div>
  )

// A small picture of an artifact, for a peek: the image itself, the lines the agent
// pointed at, or the page in a browser frame. Blank until it loads.
export const ArtifactThumb = ({ load }: { load: ArtifactLoad }): React.JSX.Element | null => {
  if (load.status !== "ready") return null
  const { content } = load
  return content.kind === "image" ? (
    <img src={content.src} alt="" />
  ) : content.kind === "file" && isMarkdown(content.path) ? (
    // A document in miniature, as a plan is: its title over its sections.
    <span className="peek-plan">
      <b>{titleOf(content.path, content.lines.join("\n"))}</b>
      {headingsOf(content.lines.join("\n"))
        .slice(0, 4)
        .map((heading) => (
          <span key={heading.at}>{heading.text}</span>
        ))}
    </span>
  ) : content.kind === "file" ? (
    <code className="peek-code">{pointedLines(content).join("\n")}</code>
  ) : (
    <span className="peek-page">
      <span className="peek-page-bar">
        <i />
        <i />
        <i />
      </span>
      {content.snapshot ? (
        <img src={content.snapshot} alt="" />
      ) : (
        <span className="peek-page-url">{content.url}</span>
      )}
    </span>
  )
}

export const ArtifactViewer = ({
  artifact,
  load,
  actions,
}: Actions & {
  artifact: Shown
  load: ArtifactLoad
}): React.JSX.Element => (
  <div
    className="artifact-viewer"
    aria-busy={load.status === "loading"}
    data-document={
      (load.status === "ready" && load.content.kind === "file" && isMarkdown(load.content.path)) ||
      undefined
    }
  >
    {load.status === "loading" ? (
      <div className="artifact-status" />
    ) : load.status === "failed" ? (
      <div className="artifact-status">Couldn't load {artifact.name}.</div>
    ) : load.content.kind === "image" ? (
      <ImageViewer artifact={artifact} content={load.content} actions={actions} />
    ) : load.content.kind === "file" && isMarkdown(load.content.path) ? (
      <DocumentViewer content={load.content} actions={actions} />
    ) : load.content.kind === "file" ? (
      <FileViewer content={load.content} actions={actions} />
    ) : (
      <PageViewer content={load.content} actions={actions} />
    )}
  </div>
)
