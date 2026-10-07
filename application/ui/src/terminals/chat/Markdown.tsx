/* oxlint-disable react/no-array-index-key -- The nodes are read from text that has no ids; they never reorder. */
import { Check, Copy } from "lucide-react"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"

import { Tooltip } from "../../ui-toolkit/Tooltip"
import type { HighlightedLine } from "../companion/highlight"
import { fenceFile } from "./languages"
import { parseMarkdown, type Inline, type MarkdownBlock } from "./markdown-parse"

const InlineNodes = ({ nodes }: { readonly nodes: readonly Inline[] }): React.JSX.Element => (
  <>
    {nodes.map((node, index) => {
      switch (node.t) {
        case "text":
          return <Fragment key={index}>{node.text}</Fragment>
        case "code":
          return <code key={index}>{node.text}</code>
        case "strong":
          return (
            <strong key={index}>
              <InlineNodes nodes={node.children} />
            </strong>
          )
        case "em":
          return (
            <em key={index}>
              <InlineNodes nodes={node.children} />
            </em>
          )
        case "del":
          return (
            <del key={index}>
              <InlineNodes nodes={node.children} />
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

// The lines of a fenced block coloured, once the parser for its language has loaded.
const useHighlighted = (lang: string, text: string): readonly HighlightedLine[] | null => {
  const [highlighted, setHighlighted] = useState<{
    readonly of: string
    readonly lines: readonly HighlightedLine[]
  } | null>(null)
  const file = fenceFile(lang)
  useEffect(() => {
    if (!file) return
    let current = true
    import("../companion/highlight")
      .then(({ highlightLines }) => highlightLines(file, text.split("\n")))
      .then((lines) => {
        if (current && lines) setHighlighted({ of: text, lines })
      })
      // Plain text is still readable.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [file, text])
  return highlighted?.of === text ? highlighted.lines : null
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
    <div className="chat-code">
      <div className="chat-code-bar">
        <span className="chat-code-lang">{lang || "text"}</span>
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

const Block = ({ block }: { readonly block: MarkdownBlock }): React.JSX.Element => {
  switch (block.t) {
    case "p":
      return (
        <p>
          <InlineNodes nodes={block.inline} />
        </p>
      )
    case "h": {
      const Heading = `h${Math.min(6, block.level + 2)}` as "h3" | "h4" | "h5" | "h6"
      return (
        <Heading data-level={block.level}>
          <InlineNodes nodes={block.inline} />
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
          <Blocks blocks={block.blocks} />
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
                    <InlineNodes key={at} nodes={each.inline} />
                  ) : (
                    <Block key={at} block={each} />
                  ),
                )
              ) : (
                <Blocks blocks={item} />
              )}
            </li>
          ))}
        </List>
      )
    }
    case "table":
      return (
        <div
          className="chat-table nodrag nopan nowheel"
          tabIndex={0}
          role="region"
          aria-label="Table"
        >
          <table>
            <thead>
              <tr>
                {block.head.map((cell, column) => (
                  <th key={column} scope="col" style={align(block.align[column])}>
                    <InlineNodes nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} style={align(block.align[column])}>
                      <InlineNodes nodes={cell} />
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

const Blocks = ({ blocks }: { readonly blocks: readonly MarkdownBlock[] }): React.JSX.Element => (
  <>
    {blocks.map((block, index) => (
      <Block key={index} block={block} />
    ))}
  </>
)

// An agent's text, formatted. Everything is drawn as elements from what the reader found,
// so nothing the agent wrote can add markup, and only web links leave the app.
export const Markdown = ({ text }: { readonly text: string }): React.JSX.Element => {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="chat-prose">
      <Blocks blocks={blocks} />
    </div>
  )
}
