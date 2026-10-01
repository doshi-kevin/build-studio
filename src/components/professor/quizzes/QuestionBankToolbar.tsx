'use client'

import { Search, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  DIFFICULTY_LEVELS,
  DIFFICULTY_LABELS,
  type QuestionType,
  type DifficultyLevel,
} from '@/lib/validations/quiz'

interface QuestionBankToolbarProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  filterType: QuestionType | null
  onFilterTypeChange: (type: QuestionType | null) => void
  filterDifficulty: DifficultyLevel | null
  onFilterDifficultyChange: (difficulty: DifficultyLevel | null) => void
  allTags: string[]
  filterTag: string | null
  onFilterTagChange: (tag: string | null) => void
  onCreateQuestion: () => void
}

export function QuestionBankToolbar({
  searchQuery,
  onSearchChange,
  filterType,
  onFilterTypeChange,
  filterDifficulty,
  onFilterDifficultyChange,
  allTags,
  filterTag,
  onFilterTagChange,
  onCreateQuestion,
}: QuestionBankToolbarProps) {
  return (
    <div className="flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search questions..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="flex gap-2 flex-wrap">
        <Select
          value={filterType ?? 'all'}
          onValueChange={(v) => onFilterTypeChange(v === 'all' ? null : (v as QuestionType))}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {QUESTION_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filterDifficulty ?? 'all'}
          onValueChange={(v) =>
            onFilterDifficultyChange(v === 'all' ? null : (v as DifficultyLevel))
          }
        >
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Difficulty" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            {DIFFICULTY_LEVELS.map((d) => (
              <SelectItem key={d} value={d}>
                {DIFFICULTY_LABELS[d]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {allTags.length > 0 && (
          <Select
            value={filterTag ?? 'all'}
            onValueChange={(v) => onFilterTagChange(v === 'all' ? null : v)}
          >
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tags</SelectItem>
              {allTags.map((tag) => (
                <SelectItem key={tag} value={tag}>
                  {tag}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button onClick={onCreateQuestion}>
          <Plus className="h-4 w-4 mr-2" />
          Add Question
        </Button>
      </div>
    </div>
  )
}
