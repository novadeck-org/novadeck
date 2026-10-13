import { ChevronRight } from "lucide-react"
import { useState } from "react"
import type { ReactNode } from "react"

import {
  constraints,
  discriminator,
  enumValues,
  isSchema,
  properties,
  requiredOf,
  typeLabel,
  variantLabel,
  view,
} from "./model.ts"
import type { Schema, View } from "./model.ts"

const columns =
  "grid grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)_52px_minmax(0,1.5fr)] items-start gap-x-3"

const Chip = ({ children, title }: { children: ReactNode; title?: string | undefined }) => (
  <span
    title={title}
    className="inline-block max-w-full truncate rounded-sm bg-raised px-1 align-middle font-mono text-[10.5px] leading-4 text-muted"
  >
    {children}
  </span>
)

const TypePill = ({ children }: { children: string }) => (
  <span className="block max-w-full truncate rounded-sm border border-[var(--color-outline)] px-1.5 font-mono text-[11px] leading-[18px]">
    {children}
  </span>
)

const itemsOf = (s: Schema): Schema | null => (isSchema(s["items"]) ? s["items"] : null)

const valueOf = (s: Schema): Schema | null =>
  isSchema(s["additionalProperties"]) && !properties(s).length ? s["additionalProperties"] : null

// Whether a value has anything to open: fields, variants, or a container of those.
const expandable = (root: Schema, v: View, depth = 0): boolean => {
  if (depth > 6 || enumValues(v)) return false
  if (v.variants.length > 1)
    return v.variants.some((each) => expandable(root, view(root, each), depth + 1))
  if (properties(v.schema).length) return true
  const items = itemsOf(v.schema)
  if (v.schema["type"] === "array" && items) return expandable(root, view(root, items), depth + 1)
  const value = valueOf(v.schema)
  return value ? expandable(root, view(root, value), depth + 1) : false
}

const Details = ({ v, description }: { v: View; description: unknown }) => {
  const values = enumValues(v)
  const chips = constraints(v)
  const shown = values?.slice(0, 5) ?? []
  return (
    <div className="min-w-0 space-y-1 text-[12px] leading-[18px]">
      {typeof description === "string" ? <div className="text-fg">{description}</div> : null}
      {chips.length || values ? (
        <div className="flex flex-wrap gap-1">
          {shown.map((each) => (
            <Chip key={String(each)}>{JSON.stringify(each)}</Chip>
          ))}
          {values && values.length > shown.length ? (
            <Chip
              title={values.map(String).join(", ")}
            >{`+${values.length - shown.length} more`}</Chip>
          ) : null}
          {chips.map((each) => (
            <Chip key={each} title={each}>
              {each}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const Field = ({
  root,
  name,
  schema,
  required,
  depth,
}: {
  root: Schema
  name: string
  schema: Schema
  required: boolean
  depth: number
}) => {
  const v = view(root, schema)
  const open0 = depth < 2
  const [open, setOpen] = useState(open0)
  const can = expandable(root, v)
  return (
    <>
      <div className={`${columns} border-t border-line py-1.5 leading-[18px]`}>
        <div className="flex min-w-0 items-start gap-0.5" style={{ paddingLeft: depth * 14 }}>
          {can ? (
            <button
              type="button"
              aria-label={open ? "Collapse" : "Expand"}
              onClick={() => setOpen(!open)}
              className="mt-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center text-muted hover:text-accent"
            >
              <ChevronRight size={13} className={open ? "rotate-90" : ""} />
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <span className="min-w-0 break-words font-mono text-[12.5px] font-medium leading-[18px]">
            {name}
          </span>
        </div>
        <div className="flex min-w-0">
          <TypePill>{typeLabel(root, v)}</TypePill>
        </div>
        <div className="leading-[18px]">
          {required ? (
            <span className="font-mono text-[10px] font-semibold uppercase text-warn">req</span>
          ) : (
            <span className="font-mono text-[10px] uppercase text-muted">opt</span>
          )}
        </div>
        <Details v={v} description={schema["description"] ?? v.schema["description"]} />
      </div>
      {can && open ? <Nested root={root} schema={schema} depth={depth + 1} /> : null}
    </>
  )
}

const Caption = ({ depth, children }: { depth: number; children: ReactNode }) => (
  <div
    className="border-t border-line py-1 font-mono text-[10.5px] text-muted"
    style={{ paddingLeft: depth * 14 + 32 }}
  >
    {children}
  </div>
)

const Variants = ({
  root,
  variants,
  depth,
}: {
  root: Schema
  variants: Schema[]
  depth: number
}) => {
  const [index, setIndex] = useState(0)
  const key = discriminator(root, variants)
  const current = variants[Math.min(index, variants.length - 1)]!
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-1 border-t border-line py-2"
        style={{ paddingLeft: depth * 14 + 32 }}
      >
        <span className="mr-1 font-mono text-[10.5px] text-muted">
          {key ? `${key} ·` : "one of"}
        </span>
        {variants.map((variant, i) => (
          <button
            key={variantLabel(root, variant, key, i)}
            type="button"
            onClick={() => setIndex(i)}
            className={`cursor-pointer rounded-sm border px-1.5 font-mono text-[11px] leading-[18px] ${
              i === index
                ? "border-accent text-accent"
                : "border-[var(--color-outline)] text-muted hover:border-accent hover:text-fg"
            }`}
          >
            {variantLabel(root, variant, key, i)}
          </button>
        ))}
      </div>
      <Body
        key={variantLabel(root, current, key, index)}
        root={root}
        schema={current}
        depth={depth}
      />
    </>
  )
}

// The rows inside something expandable.
const Nested = ({ root, schema, depth }: { root: Schema; schema: Schema; depth: number }) => {
  const v = view(root, schema)
  if (v.variants.length > 1) return <Variants root={root} variants={v.variants} depth={depth} />
  const props = properties(v.schema)
  if (props.length) {
    const required = requiredOf(v.schema)
    return (
      <>
        {props.map(([name, prop]) => (
          <Field
            key={name}
            root={root}
            name={name}
            schema={prop}
            required={required.has(name)}
            depth={depth}
          />
        ))}
      </>
    )
  }
  const items = itemsOf(v.schema)
  if (items)
    return (
      <>
        <Caption depth={depth}>each item</Caption>
        <Nested root={root} schema={items} depth={depth} />
      </>
    )
  const value = valueOf(v.schema)
  if (value)
    return (
      <>
        <Caption depth={depth}>each value</Caption>
        <Nested root={root} schema={value} depth={depth} />
      </>
    )
  return null
}

// A schema as rows. Something that is not an object gets one row for its value.
const Body = ({ root, schema, depth }: { root: Schema; schema: Schema; depth: number }) =>
  expandable(root, view(root, schema)) ? (
    <Nested root={root} schema={schema} depth={depth} />
  ) : (
    <Field root={root} name="(value)" schema={schema} required depth={depth} />
  )

export const ParamsTable = ({ schema }: { schema: Schema }) => (
  <div className="overflow-hidden rounded-sm border border-[var(--color-outline)] bg-panel">
    <div
      className={`${columns} bg-raised px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted`}
    >
      <span className="pl-5">Name</span>
      <span>Type</span>
      <span>Req</span>
      <span>Details</span>
    </div>
    <div className="[&>*]:px-3 [&>div:first-child]:border-t-0">
      <Body root={schema} schema={schema} depth={0} />
    </div>
  </div>
)
