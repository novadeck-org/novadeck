/* oxlint-disable react/no-array-index-key -- The nodes are read from text that has no ids; they never reorder. */
import { highlightLines, type HighlightedLine } from "@novadeck/viewers/code"
import {
  fenceLanguage,
  parseMarkdown,
  type Inline,
  type MarkdownBlock,
} from "@novadeck/viewers/markdown-blocks"
import { Check, Copy } from "lucide-react"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"

import { MentionedText, MentionSpan } from "./Mentioned"
import { mentionInCode, type Mention } from "./mentions"
import { Tooltip } from "./Tooltip"

const InlineNodes = ({
  nodes,
  mention,
}: {
  readonly nodes: readonly Inline[]
  readonly mention?: Mention | undefined
}): React.JSX.Element => (
  <>
    {nodes.map((node, index) => {
      switch (node.t) {
        case "text":
          return (
            <Fragment key={index}>
              <MentionedText text={node.text} mention={mention} />
            </Fragment>
          )
        case "code": {
          const named = mention && mentionInCode(node.text, mention)
          return (
            <code key={index}>
              {named ? (
                <>
                  <MentionSpan text={named.handle} hue={named.hue} />
                  {named.rest}
                </>
              ) : (
                node.text
              )}
            </code>
          )
        }
        case "strong":
          return (
            <strong key={index}>
              <InlineNodes nodes={node.children} mention={mention} />
            </strong>
          )
        case "em":
          return (
            <em key={index}>
              <InlineNodes nodes={node.children} mention={mention} />
            </em>
          )
        case "del":
          return (
            <del key={index}>
              <InlineNodes nodes={node.children} mention={mention} />
            </del>
          )
        case "br":
          return <br key={index} />
        case "link":
          // Where it goes is the address, whatever its text says.
          return (
            <a
              key={index}
              href={node.href}
              target="_blank"
              rel="noopener noreferrer"
              title={node.href}
            >
              <InlineNodes nodes={node.children} />
            </a>
          )
      }
    })}
  </>
)

// The lines of a fenced block coloured, once the parser for its language has loaded: the
// lines of this text in this language, never another's while the new ones load.
const useHighlighted = (lang: string, text: string): readonly HighlightedLine[] | null => {
  const [highlighted, setHighlighted] = useState<{
    readonly of: string
    readonly language: string
    readonly lines: readonly HighlightedLine[]
  } | null>(null)
  const language = fenceLanguage(lang)
  useEffect(() => {
    if (!language) return
    let current = true
    highlightLines(language, text.split("\n"))
      .then((lines) => {
        if (current && lines) setHighlighted({ of: text, language, lines })
      })
      // Plain text is still readable.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [language, text])
  return highlighted?.of === text && highlighted.language === language ? highlighted.lines : null
}

const CodeBlock = ({
  lang,
  text,
}: {
  readonly lang: string
  readonly text: string
}): React.JSX.Element => {
  const lines = useHighlighted(lang, text)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = (): void => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1500)
      })
      // A page that may not write the clipboard simply doesn't copy.
      .catch(() => {})
  }
  return (
    <div className="markdown-code">
      <div className="markdown-code-bar">
        <span className="markdown-code-lang">{lang || "text"}</span>
        <Tooltip content={copied ? "Copied" : "Copy"}>
          <button
            type="button"
            className="icon-button small dim nodrag nopan"
            aria-label="Copy code"
            onClick={copy}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </Tooltip>
      </div>
      {/* Focusable, so its overflow can be scrolled by keyboard. */}
      <pre tabIndex={0} aria-label={lang ? `${lang} code` : "Code"}>
        <code>
          {lines
            ? lines.map((line, index) => (
                <Fragment key={index}>
                  {line.map((run) =>
                    run.classes ? (
                      <span key={run.from} className={run.classes}>
                        {run.text}
                      </span>
                    ) : (
                      <Fragment key={run.from}>{run.text}</Fragment>
                    ),
                  )}
                  {index < lines.length - 1 ? "\n" : ""}
                </Fragment>
              ))
            : text}
        </code>
      </pre>
    </div>
  )
}

const Block = ({
  block,
  mention,
}: {
  readonly block: MarkdownBlock
  readonly mention?: Mention | undefined
}): React.JSX.Element => {
  switch (block.t) {
    case "p":
      return (
        <p>
          <InlineNodes nodes={block.inline} mention={mention} />
        </p>
      )
    case "h": {
      const Heading = `h${Math.min(6, block.level + 2)}` as "h3" | "h4" | "h5" | "h6"
      return (
        <Heading data-level={block.level}>
          <InlineNodes nodes={block.inline} mention={mention} />
        </Heading>
      )
    }
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} />
    case "hr":
      return <hr />
    case "quote":
      return (
        <blockquote>
          <Blocks blocks={block.blocks} mention={mention} />
        </blockquote>
      )
    case "list": {
      const List = block.ordered ? "ol" : "ul"
      return (
        <List {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
          {block.items.map((item, index) => (
            <li key={index}>
              {/* A tight list's text is not set as paragraphs. */}
              {block.tight ? (
                item.map((each, at) =>
                  each.t === "p" ? (
                    <InlineNodes key={at} nodes={each.inline} mention={mention} />
                  ) : (
                    <Block key={at} block={each} mention={mention} />
                  ),
                )
              ) : (
                <Blocks blocks={item} mention={mention} />
              )}
            </li>
          ))}
        </List>
      )
    }
    case "table":
      return (
        <div
          className="markdown-table nodrag nopan nowheel"
          tabIndex={0}
          role="region"
          aria-label="Table"
        >
          <table>
            <thead>
              <tr>
                {block.head.map((cell, column) => (
                  <th key={column} scope="col" style={align(block.align[column])}>
                    <InlineNodes nodes={cell} mention={mention} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} style={align(block.align[column])}>
                      <InlineNodes nodes={cell} mention={mention} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

const align = (
  value: "left" | "center" | "right" | null | undefined,
): React.CSSProperties | undefined => (value ? { textAlign: value } : undefined)

const Blocks = ({
  blocks,
  mention,
}: {
  readonly blocks: readonly MarkdownBlock[]
  readonly mention?: Mention | undefined
}): React.JSX.Element => (
  <>
    {blocks.map((block, index) => (
      <Block key={index} block={block} mention={mention} />
    ))}
  </>
)

// An agent's text, formatted. Everything is drawn as elements from what the reader found,
// so nothing the agent wrote can add markup, and only web links leave the app. Where `mention`
// gives a hue for a handle, the agents it names are drawn in their hues (text and inline code,
// never links or code blocks).
export const Markdown = ({
  text,
  mention,
}: {
  readonly text: string
  readonly mention?: Mention | undefined
}): React.JSX.Element => {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="markdown">
      <Blocks blocks={blocks} mention={mention} />
    </div>
  )
}
