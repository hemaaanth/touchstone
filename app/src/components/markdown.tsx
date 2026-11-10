import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

// Agent text is Markdown: headings, lists, tables, bold, inline code. This
// renders it with the app's quiet type scale. Sizes are relative (em), so the
// same renderer fits the 14px prose and the 13px muted reasoning. A streamed
// snapshot re-renders whole; an open table or fence just closes on the next
// tick.
const components: Components = {
  p: ({ node: _n, ...p }) => <p className="my-2 first:mt-0 last:mb-0" {...p} />,
  h1: ({ node: _n, ...p }) => <h3 className="mt-4 mb-1.5 text-[1.07em] font-semibold first:mt-0" {...p} />,
  h2: ({ node: _n, ...p }) => <h3 className="mt-4 mb-1.5 text-[1.07em] font-semibold first:mt-0" {...p} />,
  h3: ({ node: _n, ...p }) => <h4 className="mt-3 mb-1 font-semibold first:mt-0" {...p} />,
  h4: ({ node: _n, ...p }) => <h4 className="mt-3 mb-1 font-medium first:mt-0" {...p} />,
  h5: ({ node: _n, ...p }) => <h4 className="mt-3 mb-1 font-medium first:mt-0" {...p} />,
  h6: ({ node: _n, ...p }) => <h4 className="mt-3 mb-1 font-medium first:mt-0" {...p} />,
  ul: ({ node: _n, ...p }) => <ul className="my-2 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0" {...p} />,
  ol: ({ node: _n, ...p }) => <ol className="my-2 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0" {...p} />,
  li: ({ node: _n, ...p }) => <li className="pl-0.5 marker:text-muted-foreground" {...p} />,
  strong: ({ node: _n, ...p }) => <strong className="font-semibold text-foreground" {...p} />,
  a: ({ node: _n, ...p }) => (
    <a className="underline underline-offset-2 hover:text-foreground" target="_blank" rel="noreferrer" {...p} />
  ),
  blockquote: ({ node: _n, ...p }) => <blockquote className="my-2 border-l-2 border-border pl-3" {...p} />,
  hr: () => <hr className="my-3 border-border" />,
  // Inline code. A fenced block's <code> sits in <pre>, which resets these.
  code: ({ node: _n, className, ...p }) => (
    <code
      className={cn("rounded bg-muted px-1 py-px font-mono text-[0.88em] break-words", className)}
      {...p}
    />
  ),
  pre: ({ node: _n, ...p }) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-[0.85em] leading-relaxed [&_code]:bg-transparent [&_code]:p-0"
      {...p}
    />
  ),
  table: ({ node: _n, ...p }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full border-collapse text-[0.88em]" {...p} />
    </div>
  ),
  th: ({ node: _n, ...p }) => (
    <th className="border-b border-border/60 bg-muted/40 px-2.5 py-1.5 text-left font-medium" {...p} />
  ),
  td: ({ node: _n, ...p }) => (
    <td className="border-b border-border/40 px-2.5 py-1.5 align-top [tr:last-child_&]:border-b-0" {...p} />
  ),
}

const plugins = [remarkGfm]

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 break-words", className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
