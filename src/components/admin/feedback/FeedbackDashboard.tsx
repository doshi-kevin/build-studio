// Admin feedback dashboard — stats cards, filters, and feedback table.
// Shows all feedback with filtering by status, category, and role.

'use client'

import { useState, useMemo } from 'react'
import { Search, MessageSquare, Bug, Lightbulb, AlertCircle, Palette, HelpCircle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { FeedbackDetailSheet } from '@/components/admin/feedback/FeedbackDetailSheet'

const RATING_EMOJIS: Record<number, string> = { 1: '😞', 2: '😐', 3: '😊' }

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  new: 'default',
  reviewed: 'secondary',
  resolved: 'outline',
  dismissed: 'destructive',
}

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  reviewed: 'Reviewed',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}

const CATEGORY_ICONS: Record<string, typeof Bug> = {
  bug: Bug,
  feature_request: Lightbulb,
  content_issue: AlertCircle,
  ux: Palette,
  general: HelpCircle,
}

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'Bug',
  feature_request: 'Feature Request',
  content_issue: 'Content Issue',
  ux: 'UX',
  general: 'General',
}

const ROLE_LABELS: Record<string, string> = {
  institution_admin: 'Admin',
  professor: 'Professor',
  student: 'Student',
  ta: 'TA',
}

interface FeedbackUser {
  id: string
  name: string | null
  email: string
  avatar_url: string | null
}

interface FeedbackItem {
  id: string
  user_id: string
  user_role: string
  rating: number
  category: string
  message: string | null
  page_url: string
  page_context: Record<string, unknown>
  status: string
  admin_notes: string | null
  created_at: string
  updated_at: string
  user: FeedbackUser
}

interface FeedbackStats {
  total: number
  byStatus: Record<string, number>
  byCategory: Record<string, number>
}

interface FeedbackDashboardProps {
  feedbacks: FeedbackItem[]
  stats: FeedbackStats
}

export function FeedbackDashboard({ feedbacks, stats }: FeedbackDashboardProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [roleFilter, setRoleFilter] = useState('all')
  const [selectedFeedback, setSelectedFeedback] = useState<FeedbackItem | null>(null)

  const filtered = useMemo(() => {
    return feedbacks.filter((fb) => {
      if (statusFilter !== 'all' && fb.status !== statusFilter) return false
      if (categoryFilter !== 'all' && fb.category !== categoryFilter) return false
      if (roleFilter !== 'all' && fb.user_role !== roleFilter) return false
      if (search) {
        const q = search.toLowerCase()
        const matchesName = fb.user?.name?.toLowerCase().includes(q)
        const matchesEmail = fb.user?.email?.toLowerCase().includes(q)
        const matchesMessage = fb.message?.toLowerCase().includes(q)
        const matchesPage = fb.page_url?.toLowerCase().includes(q)
        if (!matchesName && !matchesEmail && !matchesMessage && !matchesPage) return false
      }
      return true
    })
  }, [feedbacks, search, statusFilter, categoryFilter, roleFilter])

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-[family-name:var(--font-instrument-serif)] text-[28px]">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">New</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-[family-name:var(--font-instrument-serif)] text-[28px] text-foreground/60">{stats.byStatus.new}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Reviewed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-[family-name:var(--font-instrument-serif)] text-[28px] text-warning-muted-foreground">{stats.byStatus.reviewed}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Resolved</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-[family-name:var(--font-instrument-serif)] text-[28px] text-success-muted-foreground">{stats.byStatus.resolved}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, message, or page..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="reviewed">Reviewed</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="bug">Bug</SelectItem>
            <SelectItem value="feature_request">Feature Request</SelectItem>
            <SelectItem value="content_issue">Content Issue</SelectItem>
            <SelectItem value="ux">UX</SelectItem>
            <SelectItem value="general">General</SelectItem>
          </SelectContent>
        </Select>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="student">Student</SelectItem>
            <SelectItem value="professor">Professor</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Results count */}
      <p className="text-sm text-muted-foreground">
        Showing {filtered.length} of {feedbacks.length} feedback entries
      </p>

      {/* Table */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <MessageSquare className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground">No feedback found.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50px]">Rating</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="hidden md:table-cell">Message</TableHead>
                <TableHead className="hidden lg:table-cell">Page</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((fb) => {
                const CategoryIcon = CATEGORY_ICONS[fb.category] || HelpCircle
                return (
                  <TableRow
                    key={fb.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setSelectedFeedback(fb)}
                  >
                    <TableCell className="text-xl">{RATING_EMOJIS[fb.rating] || '?'}</TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{fb.user?.name || 'Unknown'}</span>
                        <span className="text-xs text-muted-foreground">{ROLE_LABELS[fb.user_role] ?? fb.user_role}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <CategoryIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-sm">{CATEGORY_LABELS[fb.category] || fb.category}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell max-w-[200px]">
                      <span className="text-sm text-muted-foreground truncate block">
                        {fb.message || '—'}
                      </span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <span className="text-xs text-muted-foreground font-mono">
                        {fb.page_url}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[fb.status] || 'secondary'}>
                        {STATUS_LABELS[fb.status] || fb.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                      {new Date(fb.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Detail sheet */}
      <FeedbackDetailSheet
        key={selectedFeedback?.id || 'none'}
        feedback={selectedFeedback}
        onClose={() => setSelectedFeedback(null)}
      />
    </div>
  )
}
