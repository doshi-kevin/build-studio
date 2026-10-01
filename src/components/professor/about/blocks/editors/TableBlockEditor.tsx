'use client'

import { Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { TableBlock } from '@/lib/validations/course-about'
import { useBlockEditor } from '../../block-editor'

interface Props {
  block: TableBlock
}

export function TableBlockEditor({ block }: Props) {
  const { dispatch } = useBlockEditor()
  const { title, rows, hasHeaderRow } = block.data

  const update = (data: Partial<TableBlock['data']>) => {
    dispatch({ type: 'UPDATE_BLOCK', payload: { blockId: block.id, data } })
  }

  const updateCell = (rowIdx: number, colIdx: number, value: string) => {
    const newRows = rows.map((row, ri) =>
      ri === rowIdx ? row.map((cell, ci) => (ci === colIdx ? value : cell)) : [...row]
    )
    update({ rows: newRows })
  }

  const addRow = () => {
    const cols = rows[0]?.length ?? 3
    update({ rows: [...rows, Array(cols).fill('')] })
  }

  const removeRow = (idx: number) => {
    if (rows.length <= 1) return
    update({ rows: rows.filter((_, i) => i !== idx) })
  }

  const addColumn = () => {
    update({ rows: rows.map((row) => [...row, '']) })
  }

  const removeColumn = (idx: number) => {
    if ((rows[0]?.length ?? 0) <= 1) return
    update({ rows: rows.map((row) => row.filter((_, i) => i !== idx)) })
  }

  return (
    <div className="space-y-3">
      <Input
        value={title}
        onChange={(e) => update({ title: e.target.value })}
        placeholder="Section title (optional)…"
        className="mb-3 h-auto border-none bg-transparent p-0 font-serif text-2xl focus-visible:ring-0"
      />
      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`header-${block.id}`}
            checked={hasHeaderRow}
            onCheckedChange={(checked) => update({ hasHeaderRow: Boolean(checked) })}
          />
          <Label htmlFor={`header-${block.id}`} className="text-xs">Header row</Label>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-3 w-3 mr-1" /> Row
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => removeRow(rows.length - 1)}
          disabled={rows.length <= 1}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-3 w-3 mr-1" /> Row
        </Button>
        <Button variant="outline" size="sm" onClick={addColumn}>
          <Plus className="h-3 w-3 mr-1" /> Column
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => removeColumn((rows[0]?.length ?? 1) - 1)}
          disabled={(rows[0]?.length ?? 0) <= 1}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="h-3 w-3 mr-1" /> Column
        </Button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          {/* Column delete buttons row */}
          {(rows[0]?.length ?? 0) > 1 && (
            <thead>
              <tr>
                {rows[0]?.map((_, colIdx) => (
                  <th key={colIdx} className="p-0 border-none bg-transparent">
                    <div className="flex justify-center py-0.5">
                      <button
                        onClick={() => removeColumn(colIdx)}
                        className="p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title={`Delete column ${colIdx + 1}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </th>
                ))}
                <th className="w-7 border-none p-0" />
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="group/row">
                {row.map((cell, colIdx) => (
                  <td
                    key={colIdx}
                    className={cn(
                      'border border-border px-2 py-1.5',
                      hasHeaderRow && rowIdx === 0 && 'bg-muted font-semibold',
                    )}
                  >
                    <input
                      value={cell}
                      onChange={(e) => updateCell(rowIdx, colIdx, e.target.value)}
                      placeholder={hasHeaderRow && rowIdx === 0 ? 'Header' : ''}
                      className="w-full bg-transparent outline-none text-sm"
                    />
                  </td>
                ))}
                {/* Row delete button */}
                <td className="w-7 border-none p-0 align-middle">
                  {rows.length > 1 && (
                    <button
                      onClick={() => removeRow(rowIdx)}
                      className="p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors ml-0.5"
                      title={`Delete row ${rowIdx + 1}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
