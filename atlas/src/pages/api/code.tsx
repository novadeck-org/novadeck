import { Check, Copy } from "lucide-react"
import { useState } from "react"
import type { ReactNode } from "react"

import type { Procedure } from "../../atlas.ts"
import { example, isEmpty, jsLiteral, tsType } from "./model.ts"
import type { Schema } from "./model.ts"

import "./api.css"

type Kind = "ts" | "json" | "js"

const token =
  /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b|\b(true|false|null|undefined)\b|\b(const|await|for|of|Promise|AsyncIterable|Array|Record|string|number|boolean|unknown|never|void)\b|([A-Za-z_$][\w$]*)(\??:)|(\.[A-Za-z_$][\w$]*)/g

// Minimal highlighting: strings, numbers, keywords and property names are enough to scan.
const highlight = (code: string): ReactNode[] => {
  const out: ReactNode[] = []
  let last = 0
  for (const match of code.matchAll(token)) {
    if (match.index > last) out.push(code.slice(last, match.index))
    const [text, comment, string, colon, number, literal, keyword, key, keyColon] = match
    if (comment)
      out.push(
        <span key={match.index} style={{ color: "var(--code-dim)" }}>
          {comment}
        </span>,
      )
    else if (string)
      out.push(
        <span key={match.index} style={{ color: colon ? "var(--code-key)" : "var(--code-str)" }}>
          {string}
          {colon ? <span style={{ color: "var(--code-fg)" }}>{colon}</span> : null}
        </span>,
      )
    else if (number || literal)
      out.push(
        <span key={match.index} style={{ color: "var(--code-num)" }}>
          {text}
        </span>,
      )
    else if (keyword)
      out.push(
        <span
          key={match.index}
          style={{
            color:
              /^(string|number|boolean|unknown|never|void|Promise|AsyncIterable|Array|Record)$/.test(
                keyword,
              )
                ? "var(--code-type)"
                : "var(--code-kw)",
          }}
        >
          {keyword}
        </span>,
      )
    else if (key)
      out.push(
        <span key={match.index}>
          <span style={{ color: "var(--code-key)" }}>{key}</span>
          {keyColon}
        </span>,
      )
    else out.push(text)
    last = match.index + text.length
  }
  out.push(code.slice(last))
  return out
}

const CopyButton = ({ text }: { text: string }) => {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      aria-label="Copy"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
      className="icon-button small w-auto gap-1 px-1.5 text-caption"
      style={{ color: "var(--code-dim)" }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      {done ? "Copied" : "Copy"}
    </button>
  )
}

const Block = ({ title, code, kind }: { title: string; code: string; kind: Kind }) => (
  <section className="border-b" style={{ borderColor: "var(--code-line)" }}>
    <div className="flex items-center justify-between px-4 pt-3">
      <h3 className="section-label m-0" style={{ color: "var(--code-dim)" }}>
        {title}
      </h3>
      <CopyButton text={code} />
    </div>
    <pre
      className="m-0 overflow-x-auto px-4 pb-4 pt-2 font-mono text-[12px] leading-[19px]"
      data-kind={kind}
    >
      {highlight(code)}
    </pre>
  </section>
)

const wrap = (inner: string) => (inner.startsWith("\n") ? `${inner}\n` : inner)

const schemaOf = (schema: Schema | null): Schema | null => (isEmpty(schema) ? null : schema)

export const CodePane = ({ p }: { p: Procedure }) => {
  const input = schemaOf(p.input)
  const output = schemaOf(p.output)
  const stream = p.kind === "stream"
  const inputType = input ? tsType(input, input, 1) : null
  const outputType = output ? tsType(output, output, 0) : "void"
  const result = stream
    ? `Promise<AsyncIterable<${wrap(outputType)}>>`
    : `Promise<${wrap(outputType)}>`
  const signature = `${p.id}(${inputType ? `\n  input: ${inputType},\n` : ""}): ${result}`
  const request = input ? example(input, input) : null
  const response = output ? example(output, output) : null
  const argument = request === null ? "" : jsLiteral(request)
  const client = stream
    ? `const events = await wire.${p.id}(${argument})\n\nfor await (const event of events) {\n  // ${output ? "handle each event" : "event"}\n}`
    : `${output ? "const result = " : ""}await wire.${p.id}(${argument})`

  return (
    <aside className="code-pane flex h-full w-[400px] shrink-0 flex-col overflow-auto">
      <Block title="Signature" code={signature} kind="ts" />
      {input ? (
        <Block title="Request example" code={JSON.stringify(request, null, 2)} kind="json" />
      ) : null}
      {output ? (
        <Block
          title={stream ? "Event example" : "Response example"}
          code={JSON.stringify(response, null, 2)}
          kind="json"
        />
      ) : null}
      <Block title="Client" code={client} kind="js" />
    </aside>
  )
}
