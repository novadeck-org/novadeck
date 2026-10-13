import { useState } from "react"
import type { ReactNode } from "react"

import type { JsonSchema } from "../atlas.ts"
import { isSchema, resolve } from "./json-schema.ts"
import type { Schema } from "./json-schema.ts"

const list = (value: unknown): Schema[] => (Array.isArray(value) ? value.filter(isSchema) : [])

// One type as a pill. Primitives are tinted by kind so shape reads before names do.
const tone = (label: string) =>
  label === "string"
    ? "border-[var(--g-ui)]"
    : label === "number" || label === "integer"
      ? "border-[var(--g-runner)]"
      : label === "boolean"
        ? "border-[var(--g-host)]"
        : "border-line"

const Pill = ({ children, title }: { children: ReactNode; title?: string | undefined }) => {
  const label = typeof children === "string" ? children : ""
  return (
    <span
      title={title}
      className={`inline-block rounded-sm border bg-raised px-1 font-mono text-[11px] leading-4 ${tone(label)}`}
    >
      {children}
    </span>
  )
}

const Rows = ({ children }: { children: ReactNode }) => (
  <div className="ml-1.5 space-y-0.5 border-l border-[var(--color-line-strong)] pl-2.5">
    {children}
  </div>
)

const Type = ({
  root,
  schema,
  depth,
}: {
  root: Schema
  schema: Schema
  depth: number
}): ReactNode => {
  if (depth > 7) return <Pill>…</Pill>
  const s = resolve(root, schema)
  if ("const" in s) return <Pill>{JSON.stringify(s["const"])}</Pill>
  if (Array.isArray(s["enum"])) {
    const values = s["enum"]
    return (
      <span className="inline-flex flex-wrap gap-1">
        {values.slice(0, 6).map((v) => (
          <Pill key={String(v)}>{JSON.stringify(v)}</Pill>
        ))}
        {values.length > 6 ? (
          <Pill title={values.join(", ")}>{`+${values.length - 6}`}</Pill>
        ) : null}
      </span>
    )
  }

  const union = list(s["anyOf"]).length ? list(s["anyOf"]) : list(s["oneOf"])
  if (union.length) {
    const simple = union.every((v) => !isSchema(v["properties"]) && v["type"] !== "array")
    return (
      <span className={simple ? "inline-flex flex-wrap items-center gap-1" : "block"}>
        {union.map((variant, i) => (
          <span key={JSON.stringify(variant)} className={simple ? "" : "mt-0.5 block"}>
            {simple ? null : (
              <span className="text-[10px] text-muted">{i === 0 ? "either" : "or"}</span>
            )}
            <Type root={root} schema={variant} depth={depth + 1} />
          </span>
        ))}
      </span>
    )
  }
  const all = list(s["allOf"])
  if (all.length) {
    return (
      <span className="block">
        {all.map((part) => (
          <Type key={JSON.stringify(part)} root={root} schema={part} depth={depth + 1} />
        ))}
      </span>
    )
  }

  const type = Array.isArray(s["type"]) ? s["type"].join(" | ") : s["type"]
  const props = isSchema(s["properties"])
    ? Object.entries(s["properties"]).filter((e): e is [string, Schema] => isSchema(e[1]))
    : []
  if (type === "object" || props.length) {
    if (!props.length) {
      const extra = s["additionalProperties"]
      return isSchema(extra) ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Pill>map</Pill>
          <Type root={root} schema={extra} depth={depth + 1} />
        </span>
      ) : (
        <Pill>{"{}"}</Pill>
      )
    }
    const required = new Set(Array.isArray(s["required"]) ? s["required"] : [])
    return (
      <Rows>
        {props.map(([name, prop]) => {
          const description = resolve(root, prop)["description"] ?? prop["description"]
          const optional = !required.has(name)
          return (
            <div key={name} className="flex flex-wrap items-baseline gap-x-1.5">
              <span
                className={`font-mono text-[12px] ${optional ? "text-muted" : "text-fg"}`}
                title={typeof description === "string" ? description : undefined}
              >
                {name}
                {optional ? <span className="opacity-60">?</span> : null}
              </span>
              <Type root={root} schema={prop} depth={depth + 1} />
            </div>
          )
        })}
      </Rows>
    )
  }
  if (type === "array") {
    const items = s["items"]
    return (
      <span className="inline-flex flex-wrap items-baseline gap-1">
        <Pill>list</Pill>
        {isSchema(items) ? <Type root={root} schema={items} depth={depth + 1} /> : <Pill>any</Pill>}
      </span>
    )
  }
  const bounds = ["format", "minimum", "maximum", "minLength", "maxLength"]
    .filter(
      (k) =>
        k in s && !(typeof s[k] === "number" && Math.abs(Number(s[k])) >= Number.MAX_SAFE_INTEGER),
    )
    .map((k) => `${k}=${String(s[k])}`)
    .join(", ")
  return (
    <Pill title={bounds || undefined}>
      {typeof type === "string" ? type : Object.keys(s).length ? "unknown" : "any"}
    </Pill>
  )
}

export const SchemaView = ({ schema }: { schema: JsonSchema | null }) => {
  const [raw, setRaw] = useState(false)
  if (!schema) return <span className="text-[12px] text-muted">none</span>
  const top = schema as Schema
  return (
    <div>
      {raw ? (
        <pre className="max-h-64 overflow-auto font-mono text-[11px] leading-4">
          {JSON.stringify(schema, null, 2)}
        </pre>
      ) : (
        <Type root={top} schema={top} depth={0} />
      )}
      <button
        type="button"
        onClick={() => setRaw(!raw)}
        className="mt-1 cursor-pointer font-mono text-[10px] text-muted hover:text-fg"
      >
        {raw ? "tree" : "{ }"}
      </button>
    </div>
  )
}
