'use client'

import { cn } from '@/lib/utils'
import type { TableBlock } from '@/lib/validations/course-about'

interface Props {
  block: TableBlock
}

export function TableBlockPreview({ block }: Props) {
  const { title, rows, hasHeaderRow } = block.data
  if (rows.length === 0) return null

  return (
    <div className="space-y-3">
      {title && <h2 className="font-serif text-2xl text-foreground">{title}</h2>}
      <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full text-sm">
        {hasHeaderRow && rows.length > 0 && (
          <thead>
            <tr>
              {rows[0].map((cell, i) => (
                <th key={i} className="border border-border bg-muted px-3 py-2 text-left font-semibold">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.slice(hasHeaderRow ? 1 : 0).map((row, rowIdx) => (
            <tr key={rowIdx} className={cn(rowIdx % 2 === 1 && 'bg-muted/30')}>
              {row.map((cell, colIdx) => (
                <td key={colIdx} className="border border-border px-3 py-2">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}
