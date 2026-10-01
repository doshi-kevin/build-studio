/**
 * StudentSubmissionTab — Devpost-inspired project submission form.
 *
 * Collects title, tagline, description, story sections, tech stack, links,
 * and documents. Auto-saves every 3 seconds (debounced). Warns on page unload
 * if unsaved. Manual "Save Draft" + "Submit Project" buttons available.
 *
 * Type: Client Component
 */
'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Send,
  Save,
  Github,
  Video,
  Link2,
  Plus,
  X,
  Loader2,
  CheckCircle2,
  Clock,
  AlertCircle,
  Lightbulb,
  Wrench,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  FileText,
  Upload,
  Trash2,
  Bot,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  saveSubmission,
  submitProject,
  type SubmissionData,
  type SubmissionDocument,
} from '@/app/(dashboard)/student/courses/[sectionId]/projects/actions'
import { uploadFile } from '@/lib/supabase/storage'

// ── Types ───────────────────────────────────────────────────────

interface TeamMember {
  id: string
  user_id: string
  role: string
  contribution_summary?: string | null
  profile?: { name?: string | null; email?: string | null; avatar_url?: string | null }
}

interface SubmissionTabProps {
  sectionId: string
  projectId: string
  teamId: string
  members: TeamMember[]
  userRole: 'owner' | 'member' | 'viewer' | null
  /** Existing submission data (if any) */
  existingSubmission?: SubmissionData | null
  /** Due date for the project */
  dueDate?: string | null
}

// ── Helpers ─────────────────────────────────────────────────────

const STATUS_CONFIG = {
  not_submitted: { label: 'Not Submitted', icon: AlertCircle, color: 'text-muted-foreground' },
  draft: { label: 'Draft Saved', icon: Clock, color: 'text-warning-muted-foreground' },
  submitted: { label: 'Submitted', icon: CheckCircle2, color: 'text-success-muted-foreground' },
} as const

// ── Component ───────────────────────────────────────────────────

export function StudentSubmissionTab({
  sectionId,
  projectId,
  teamId,
  members,
  userRole,
  existingSubmission,
  dueDate,
}: SubmissionTabProps) {
  const router = useRouter()
  const isEditable = userRole === 'owner' || userRole === 'member'
  const isSubmitted = existingSubmission?.status === 'submitted'

  // Form state
  const [title, setTitle] = useState(existingSubmission?.title || '')
  const [tagline, setTagline] = useState(existingSubmission?.tagline || '')
  const [description, setDescription] = useState(existingSubmission?.description || '')
  const [inspiration, setInspiration] = useState(existingSubmission?.inspiration || '')
  const [whatItDoes, setWhatItDoes] = useState(existingSubmission?.what_it_does || '')
  const [howWeBuiltIt, setHowWeBuiltIt] = useState(existingSubmission?.how_we_built_it || '')
  const [challenges, setChallenges] = useState(existingSubmission?.challenges || '')
  const [accomplishments, setAccomplishments] = useState(existingSubmission?.accomplishments || '')
  const [whatWeLearned, setWhatWeLearned] = useState(existingSubmission?.what_we_learned || '')
  const [whatsNext, setWhatsNext] = useState(existingSubmission?.whats_next || '')
  const [builtWith, setBuiltWith] = useState<string[]>(existingSubmission?.built_with || [])
  const [techInput, setTechInput] = useState('')
  const [githubUrl, setGithubUrl] = useState(existingSubmission?.github_url || '')
  const [videoUrl, setVideoUrl] = useState(existingSubmission?.video_url || '')
  const [additionalLinks, setAdditionalLinks] = useState<{ label: string; url: string }[]>(
    existingSubmission?.additional_links || []
  )
  const [coverImageUrl, setCoverImageUrl] = useState(existingSubmission?.cover_image_url || '')
  const [documents, setDocuments] = useState<SubmissionDocument[]>(existingSubmission?.documents || [])
  const [isUploading, setIsUploading] = useState(false)

  // Auto-save timer ref
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedOnceRef = useRef(false)

  // UI state
  const [isSaving, setIsSaving] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [lastAutoSaved, setLastAutoSaved] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    story: true,
    tech: true,
    links: true,
    documents: true,
    media: false,
  })

  // Submission status
  const status: keyof typeof STATUS_CONFIG = existingSubmission?.status || 'not_submitted'
  const statusInfo = STATUS_CONFIG[status]
  const StatusIcon = statusInfo.icon

  // Due date logic. dueDate is a DATE (no time) — compare calendar days in UTC so it
  // doesn't flip to "past due" a day early in a behind-UTC timezone.
  const isPastDue = dueDate
    ? new Date(dueDate).getTime() < new Date(new Date().toISOString().slice(0, 10)).getTime()
    : false

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const addTech = () => {
    const trimmed = techInput.trim()
    if (trimmed && !builtWith.includes(trimmed)) {
      setBuiltWith([...builtWith, trimmed])
      setTechInput('')
    }
  }

  const removeTech = (tech: string) => {
    setBuiltWith(builtWith.filter((t) => t !== tech))
  }

  const addLink = () => {
    setAdditionalLinks([...additionalLinks, { label: '', url: '' }])
  }

  const updateLink = (index: number, field: 'label' | 'url', value: string) => {
    const updated = [...additionalLinks]
    updated[index][field] = value
    setAdditionalLinks(updated)
  }

  const removeLink = (index: number) => {
    setAdditionalLinks(additionalLinks.filter((_, i) => i !== index))
  }

  const handleDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file type
    const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword']
    if (!allowedTypes.includes(file.type)) {
      toast.error('Only PDF and Word documents are supported')
      return
    }

    // Validate file size (25MB max)
    if (file.size > 25 * 1024 * 1024) {
      toast.error('File size must be under 25MB')
      return
    }

    setIsUploading(true)
    try {
      // Prefix with sectionId so the path matches the course-materials
      // bucket's SELECT RLS policy (which recognizes paths starting with a
      // section uuid). Without this prefix, the upload itself succeeds but
      // the immediate `createSignedUrl` for the preview fails with
      // "Upload succeeded but preview URL failed".
      const folder = `${sectionId}/project-submissions/${teamId}`
      const result = await uploadFile(file, folder)

      if (result.error) {
        toast.error(result.error)
        return
      }

      if (result.data) {
        const newDoc: SubmissionDocument = {
          name: file.name,
          url: result.data.url,
          size: file.size,
          uploaded_at: new Date().toISOString(),
        }
        setDocuments((prev) => [...prev, newDoc])
        toast.success('Document uploaded')
      }
    } catch {
      toast.error('Failed to upload document')
    } finally {
      setIsUploading(false)
      // Reset the input so the same file can be re-uploaded
      e.target.value = ''
    }
  }

  const removeDocument = (index: number) => {
    setDocuments(documents.filter((_, i) => i !== index))
  }

  // Auto-save silently with 3000ms debounce (no toast — show subtle indicator)
  const performAutoSave = useCallback(async (payload: SubmissionData) => {
    if (!isEditable || isSubmitted) return
    try {
      await saveSubmission(teamId, projectId, sectionId, payload)
      savedOnceRef.current = true
      setLastAutoSaved(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
    } catch {
      // Auto-save failures are silent — user can still manually save
    }
  }, [isEditable, isSubmitted, teamId, projectId, sectionId])

  const buildPayload = (): SubmissionData => ({
    title,
    tagline,
    description,
    inspiration,
    what_it_does: whatItDoes,
    how_we_built_it: howWeBuiltIt,
    challenges,
    accomplishments,
    what_we_learned: whatWeLearned,
    whats_next: whatsNext,
    built_with: builtWith,
    github_url: githubUrl,
    demo_url: '',
    video_url: videoUrl,
    additional_links: additionalLinks.filter((l) => l.url.trim()),
    cover_image_url: coverImageUrl,
    documents,
    status: existingSubmission?.status || 'draft',
  })

  // Auto-save triggered whenever any field changes
  useEffect(() => {
    if (!isEditable || isSubmitted) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      void performAutoSave(buildPayload())
    }, 3000)
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, tagline, description, inspiration, whatItDoes, howWeBuiltIt,
      challenges, accomplishments, whatWeLearned, whatsNext, builtWith,
      githubUrl, videoUrl, additionalLinks, coverImageUrl, documents])

  // Warn before leaving if not submitted
  useEffect(() => {
    if (isSubmitted) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isSubmitted])

  // Save as draft
  const handleSave = async () => {
    setIsSaving(true)
    try {
      const result = await saveSubmission(teamId, projectId, sectionId, buildPayload())
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Draft saved')
        router.refresh()
      }
    } catch {
      toast.error('Unable to save draft. Check your connection and try again.')
    } finally {
      setIsSaving(false)
    }
  }

  // Submit confirmation state
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false)

  // Pre-submit validation — opens confirmation dialog
  const handleSubmitClick = () => {
    if (!title.trim()) {
      toast.error('Project title is required')
      return
    }
    if (!description.trim()) {
      toast.error('Project description is required')
      return
    }
    const isValidUrl = (u: string) => {
      const v = u.trim()
      if (!v) return true
      try {
        const parsed = new URL(v)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        return false
      }
    }
    const badField = !isValidUrl(githubUrl)
      ? 'GitHub'
      : !isValidUrl(videoUrl)
        ? 'demo video'
        : additionalLinks.some((l) => !isValidUrl(l.url))
          ? 'additional'
          : null
    if (badField) {
      toast.error(`Enter a valid ${badField} link (including https://)`)
      return
    }
    setSubmitConfirmOpen(true)
  }

  // Final submit — called after user confirms
  const handleSubmitConfirmed = async () => {
    setSubmitConfirmOpen(false)
    setIsSubmitting(true)
    try {
      const result = await submitProject(teamId, projectId, sectionId, buildPayload())
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success('Project submitted successfully!')
        router.refresh()
      }
    } catch {
      toast.error('Submission failed — your draft has been preserved. Try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Completion indicator
  const completionFields = [
    { label: 'Title', done: !!title.trim() },
    { label: 'Description', done: !!description.trim() },
    { label: 'What it does', done: !!whatItDoes.trim() },
    { label: 'How we built it', done: !!howWeBuiltIt.trim() },
    { label: 'Built with', done: builtWith.length > 0 },
    { label: 'GitHub link', done: !!githubUrl.trim() },
  ]
  const completedCount = completionFields.filter((f) => f.done).length
  const completionPct = Math.round((completedCount / completionFields.length) * 100)

  /* The two fields `handleSubmitClick` actually enforces. The completion meter
     spans all six, so the percentage alone reads as a gate it isn't — this says
     the quiet part out loud next to the number the student is looking at. */
  const canSubmit = !!title.trim() && !!description.trim()

  const statusTint = isSubmitted
    ? 'bg-success-muted border-success/30 text-success-muted-foreground'
    : status === 'draft'
      ? 'bg-warning-muted border-warning/30 text-warning-muted-foreground'
      : 'bg-muted/40 border-border text-muted-foreground'

  return (
    <div className="space-y-8">

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <p className="text-[11px] tracking-[0.2em] uppercase font-semibold text-muted-foreground flex items-center gap-2">
          <Bot className="w-3 h-3" />
          Final Submission
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Ship your project.{' '}
          <span className="text-muted-foreground">Tell the story.</span>
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
          This is the final showcase your professor will grade. Walk them through
          what you built, how you built it, and what you learned along the way.
        </p>
      </div>

      {/* ── Status + Progress Card ────────────────────────────────── */}
      <div className="rounded-3xl border border-border bg-card/50 overflow-hidden">
        <div className="p-5 sm:p-6 flex flex-col lg:flex-row lg:items-center gap-6">
          {/* Status */}
          <div className="flex items-center gap-4 min-w-0 lg:w-64 shrink-0">
            <div className={cn('w-12 h-12 rounded-xl border flex items-center justify-center shrink-0', statusTint)}>
              <StatusIcon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">
                Status
              </p>
              <p className="text-base font-semibold text-foreground mt-0.5 truncate">
                {statusInfo.label}
              </p>
              {existingSubmission?.submitted_at && (
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                  {new Date(existingSubmission.submitted_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
                  })}
                </p>
              )}
            </div>
          </div>

          {/* Vertical divider */}
          <div className="hidden lg:block w-px self-stretch bg-border/60" />

          {/* Completion */}
          <div className="flex-1 min-w-0">
            <p className="text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground mb-1.5">
              Completion
            </p>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold leading-none tabular-nums text-foreground">
                {completionPct}%
              </span>
              <span className="text-[11px] text-muted-foreground">
                {completedCount} of {completionFields.length} fields complete
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              {canSubmit
                ? 'Ready to submit — the rest strengthens your grade.'
                : 'Add a title and description to submit.'}
            </p>
            <div className="w-full max-w-xs h-1.5 rounded-full bg-muted overflow-hidden mt-3">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                style={{ width: `${completionPct}%` }}
              />
            </div>
          </div>

          {/* Actions */}
          {isEditable && !isSubmitted && (
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              {lastAutoSaved && (
                <span className="text-[11px] text-muted-foreground hidden xl:block whitespace-nowrap">
                  Auto-saved {lastAutoSaved}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-4 rounded-full text-[13px] font-medium gap-1.5"
                onClick={handleSave}
                disabled={isSaving}
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save Draft
              </Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      className="rounded-full gap-1.5"
                      onClick={handleSubmitClick}
                      disabled={isSubmitting || isPastDue}
                    >
                      {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Submit Project
                    </Button>
                  </TooltipTrigger>
                  {isPastDue && (
                    <TooltipContent className="text-xs">Submissions are closed — past due date</TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </div>
          )}
        </div>
      </div>

      {/* ── Checklist (collapsed) ──────────────────────────────────── */}
      {completionPct < 100 && !isSubmitted && (
        <div className="px-1">
          <p className="text-[11px] tracking-[0.15em] uppercase font-semibold text-muted-foreground mb-2">
            Completeness
          </p>
          <div className="flex flex-wrap gap-2">
            {completionFields.map((f) => (
              <span
                key={f.label}
                className={cn(
                  'text-[11px] px-2.5 py-1 rounded-full font-medium border transition-colors',
                  f.done
                    ? 'bg-foreground/5 border-foreground/20 text-foreground'
                    : 'bg-muted/30 border-border text-muted-foreground'
                )}
              >
                {f.done ? <CheckCircle2 className="w-3 h-3 inline mr-1 -mt-px" /> : null}
                {f.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Hero Section: Title + Tagline ──────────────────────────── */}
      <div className="space-y-4">
        <div>
          <label className="text-[11px] tracking-[0.15em] uppercase font-semibold text-muted-foreground mb-2 block">
            Project Title *
          </label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Give your project a memorable name"
            className="h-12 text-lg font-semibold rounded-xl border-border bg-transparent placeholder:text-muted-foreground/40"
            disabled={!isEditable || isSubmitted}
            maxLength={100}
          />
        </div>
        <div>
          <label className="text-[11px] tracking-[0.15em] uppercase font-semibold text-muted-foreground mb-2 block">
            Tagline
          </label>
          <Input
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="A short sentence that describes your project"
            className="h-10 rounded-xl border-border bg-transparent text-sm placeholder:text-muted-foreground/40"
            disabled={!isEditable || isSubmitted}
            maxLength={150}
          />
          <p className="text-[10px] text-muted-foreground/60 mt-1 text-right">{tagline.length}/150</p>
        </div>
      </div>

      {/* ── Cover Image ────────────────────────────────────────────── */}
      <div>
        <label className="text-[11px] tracking-[0.15em] uppercase font-semibold text-muted-foreground mb-2 block">
          Cover Image URL
        </label>
        <div className="flex items-center gap-3">
          <Input
            value={coverImageUrl}
            onChange={(e) => setCoverImageUrl(e.target.value)}
            placeholder="https://... (paste an image URL for your project banner)"
            className="h-10 rounded-xl border-border bg-transparent text-sm placeholder:text-muted-foreground/40 flex-1"
            disabled={!isEditable || isSubmitted}
          />
          {coverImageUrl && (
            <div className="w-16 h-10 rounded-xl border border-border overflow-hidden bg-muted/30 shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={coverImageUrl} alt="Cover" className="w-full h-full object-cover" />
            </div>
          )}
        </div>
      </div>

      {/* ── Description ────────────────────────────────────────────── */}
      <div>
        <label className="text-[11px] tracking-[0.15em] uppercase font-semibold text-muted-foreground mb-2 block">
          Description *
        </label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Provide a high-level overview of your project. What problem does it solve? Who is it for?"
          className="min-h-[120px] rounded-xl border-border bg-transparent text-[14px] leading-relaxed placeholder:text-muted-foreground/40 resize-y max-h-none"
          disabled={!isEditable || isSubmitted}
          maxLength={3000}
        />
        <p className="text-[10px] text-muted-foreground/60 mt-1 text-right">{description.length}/3000</p>
      </div>

      {/* ── Story Section (Collapsible) ────────────────────────────── */}
      <CollapsibleSection
        title="The Story"
        subtitle="Tell the story of your project — professors love context"
        icon={<Lightbulb className="w-4 h-4" />}
        index={1}
        isOpen={expandedSections.story}
        onToggle={() => toggleSection('story')}
      >
        <div className="space-y-6">
          <StoryField
            label="Inspiration"
            placeholder="What inspired you to build this? What problem caught your attention?"
            value={inspiration}
            onChange={setInspiration}
            disabled={!isEditable || isSubmitted}
          />
          <StoryField
            label="What it does"
            placeholder="Describe the core functionality. What can users do with it?"
            value={whatItDoes}
            onChange={setWhatItDoes}
            disabled={!isEditable || isSubmitted}
          />
          <StoryField
            label="How we built it"
            placeholder="Describe your technical approach — architecture, algorithms, design decisions."
            value={howWeBuiltIt}
            onChange={setHowWeBuiltIt}
            disabled={!isEditable || isSubmitted}
          />
          <StoryField
            label="Challenges we ran into"
            placeholder="What obstacles did you face? How did you overcome them?"
            value={challenges}
            onChange={setChallenges}
            disabled={!isEditable || isSubmitted}
          />
          <StoryField
            label="Accomplishments we're proud of"
            placeholder="What achievements are you most proud of?"
            value={accomplishments}
            onChange={setAccomplishments}
            disabled={!isEditable || isSubmitted}
          />
          <StoryField
            label="What we learned"
            placeholder="What new skills, technologies, or insights did you gain?"
            value={whatWeLearned}
            onChange={setWhatWeLearned}
            disabled={!isEditable || isSubmitted}
          />
          <StoryField
            label="What's next"
            placeholder="If you had more time, what would you add or improve?"
            value={whatsNext}
            onChange={setWhatsNext}
            disabled={!isEditable || isSubmitted}
          />
        </div>
      </CollapsibleSection>

      {/* ── Built With (Technologies) ──────────────────────────────── */}
      <CollapsibleSection
        title="Built With"
        subtitle="Technologies, frameworks, APIs, and tools"
        icon={<Wrench className="w-4 h-4" />}
        index={2}
        isOpen={expandedSections.tech}
        onToggle={() => toggleSection('tech')}
      >
        <div className="space-y-3">
          {isEditable && !isSubmitted && (
            <div className="flex items-center gap-2">
              <Input
                value={techInput}
                onChange={(e) => setTechInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTech() } }}
                placeholder="e.g. Python, React, TensorFlow..."
                className="h-9 rounded-xl border-border bg-transparent text-sm placeholder:text-muted-foreground/40 flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-3 rounded-xl"
                onClick={addTech}
                disabled={!techInput.trim()}
              >
                <Plus className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
          {builtWith.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {builtWith.map((tech) => (
                <Badge
                  key={tech}
                  variant="secondary"
                  className="text-xs px-3 py-1 rounded-full bg-muted/50 font-medium gap-1.5"
                >
                  {tech}
                  {isEditable && !isSubmitted && (
                    <button onClick={() => removeTech(tech)} className="hover:text-destructive transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground/60 py-2">No technologies added yet.</p>
          )}
        </div>
      </CollapsibleSection>

      {/* ── Links ──────────────────────────────────────────────────── */}
      <CollapsibleSection
        title="Links"
        subtitle="GitHub repo, video walkthrough"
        icon={<Link2 className="w-4 h-4" />}
        index={3}
        isOpen={expandedSections.links}
        onToggle={() => toggleSection('links')}
      >
        <div className="space-y-4">
          <LinkField
            icon={<Github className="w-4 h-4" />}
            label="GitHub Repository"
            placeholder="https://github.com/..."
            value={githubUrl}
            onChange={setGithubUrl}
            disabled={!isEditable || isSubmitted}
          />
          <LinkField
            icon={<Video className="w-4 h-4" />}
            label="Demo Video"
            placeholder="https://youtube.com/... or https://loom.com/..."
            value={videoUrl}
            onChange={setVideoUrl}
            disabled={!isEditable || isSubmitted}
          />

          {/* Additional links */}
          {additionalLinks.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-border/50">
              <p className="text-[11px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">
                Additional Links
              </p>
              {additionalLinks.map((link, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={link.label}
                    onChange={(e) => updateLink(i, 'label', e.target.value)}
                    placeholder="Label (e.g. Slides)"
                    className="h-9 rounded-xl border-border bg-transparent text-sm w-1/3"
                    disabled={!isEditable || isSubmitted}
                  />
                  <Input
                    value={link.url}
                    onChange={(e) => updateLink(i, 'url', e.target.value)}
                    placeholder="https://..."
                    className="h-9 rounded-xl border-border bg-transparent text-sm flex-1"
                    disabled={!isEditable || isSubmitted}
                  />
                  {isEditable && !isSubmitted && (
                    <Button variant="ghost" size="sm" className="h-9 w-9 p-0 rounded-xl" onClick={() => removeLink(i)}>
                      <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {isEditable && !isSubmitted && (
            <Button
              variant="ghost"
              size="sm"
              className="text-[12px] text-muted-foreground hover:text-foreground gap-1.5"
              onClick={addLink}
            >
              <Plus className="w-3 h-3" />
              Add another link
            </Button>
          )}
        </div>
      </CollapsibleSection>

      {/* ── Documents ──────────────────────────────────────────────── */}
      <CollapsibleSection
        title="Documents"
        subtitle="Upload PDF reports, proposals, or presentations"
        icon={<FileText className="w-4 h-4" />}
        index={4}
        isOpen={expandedSections.documents}
        onToggle={() => toggleSection('documents')}
      >
        <div className="space-y-3">
          {documents.length > 0 && (
            <div className="space-y-2">
              {documents.map((doc, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 rounded-xl border border-border bg-background"
                >
                  <div className="w-9 h-9 rounded-xl border border-border bg-muted/30 flex items-center justify-center shrink-0 text-muted-foreground">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{doc.name}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {(doc.size / 1024).toFixed(0)} KB — uploaded {new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-8 h-8 rounded-xl border border-border flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  {isEditable && !isSubmitted && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => removeDocument(i)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {isEditable && !isSubmitted && (
            <label className="flex items-center gap-3 p-4 rounded-xl border border-dashed border-border bg-muted/10 hover:bg-muted/20 transition-colors cursor-pointer">
              <div className="w-9 h-9 rounded-xl border border-border bg-muted/30 flex items-center justify-center shrink-0 text-muted-foreground">
                {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {isUploading ? 'Uploading...' : 'Upload a document'}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  PDF or Word — max 25MB
                </p>
              </div>
              <input
                type="file"
                accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="hidden"
                onChange={handleDocumentUpload}
                disabled={isUploading || isSubmitted}
              />
            </label>
          )}

          {documents.length === 0 && (isSubmitted || !isEditable) && (
            <p className="text-xs text-muted-foreground/60 py-2">No documents uploaded.</p>
          )}
        </div>
      </CollapsibleSection>

      {/* ── Team Contributions ─────────────────────────────────────── */}
      <div className="space-y-4">
        <p className="text-[11px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">
          Team Members
        </p>
        <div className="space-y-2">
          {members.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 p-3 rounded-xl border border-border bg-background hover:bg-muted/30 transition-colors cursor-default"
              title={`${m.profile?.name || 'Member'} — view details on the Team tab`}
            >
              <div className="w-8 h-8 rounded-full bg-muted/50 border border-border flex items-center justify-center shrink-0">
                <span className="text-xs font-semibold text-foreground">
                  {(m.profile?.name || m.profile?.email || '?').charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">
                  {m.profile?.name || m.profile?.email || 'Unknown'}
                </p>
                {m.contribution_summary && (
                  <p className="text-[11px] text-muted-foreground truncate mt-0.5">{m.contribution_summary}</p>
                )}
              </div>
              <Badge variant="secondary" className="text-[10px] px-2 py-0 rounded-full font-medium capitalize">
                {m.role}
              </Badge>
            </div>
          ))}
        </div>
      </div>

      {/* ── Bottom Action Bar ──────────────────────────────────────── */}
      {isEditable && !isSubmitted && (
        <div className="flex items-center justify-between pt-6 border-t border-border">
          <p className="text-xs text-muted-foreground">
            {completionPct === 100
              ? 'All fields complete — ready to submit!'
              : `${completedCount} of ${completionFields.length} fields complete`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="h-10 px-5 rounded-full text-sm font-medium gap-1.5"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save Draft
            </Button>
            <Button
              className="h-10 px-6 rounded-full text-sm font-semibold gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={handleSubmitClick}
              disabled={isSubmitting || isPastDue}
            >
              {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Submit Project
            </Button>
          </div>
        </div>
      )}

      {/* Submitted read-only notice */}
      {isSubmitted && (
        <div className="flex items-center gap-3 p-4 rounded-2xl border border-success/20 bg-success-muted/40">
          <CheckCircle2 className="w-5 h-5 text-success-muted-foreground shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">Project submitted</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Your submission is locked. Contact your professor if you need to make changes.
            </p>
          </div>
        </div>
      )}

      {/* Submit confirmation dialog */}
      <AlertDialog open={submitConfirmOpen} onOpenChange={setSubmitConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit project?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                Once submitted, your submission becomes read-only. Your team can keep using the workspace (phases, chat, docs), but you&apos;ll need your professor to reopen it before you can edit the submission itself.
              </span>
              {completedCount < completionFields.length && (
                <span className="block text-warning-muted-foreground font-medium">
                  You have completed {completedCount} of {completionFields.length} recommended fields. Missing fields can affect your grade.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go Back</AlertDialogCancel>
            <AlertDialogAction onClick={handleSubmitConfirmed}>
              Submit Project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Collapsible Section ─────────────────────────────────────────

function CollapsibleSection({
  title,
  subtitle,
  icon,
  index,
  isOpen,
  onToggle,
  children,
}: {
  title: string
  subtitle: string
  icon: React.ReactNode
  index?: number
  isOpen: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'group/section rounded-2xl border border-border overflow-hidden transition-colors',
        isOpen && 'bg-card/30',
      )}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-4 p-5 text-left hover:bg-muted/20 transition-colors"
      >
        {typeof index === 'number' && (
          <span className="text-2xl font-semibold leading-none text-muted-foreground/70 tabular-nums w-8 text-right shrink-0">
            {String(index).padStart(2, '0')}
          </span>
        )}
        <div
          className={cn(
            'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 transition-colors',
            isOpen
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-muted/30 border-border text-muted-foreground group-hover/section:text-foreground',
          )}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>
      {isOpen && (
        <div className="px-5 pb-5 pt-1">
          {children}
        </div>
      )}
    </div>
  )
}

// ── Story Field ─────────────────────────────────────────────────

function StoryField({
  label,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  return (
    <div>
      <label className="text-[12px] font-semibold text-foreground/80 mb-1.5 block">
        {label}
      </label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-h-[80px] rounded-xl border-border bg-transparent text-[13px] leading-relaxed placeholder:text-muted-foreground/40 resize-y max-h-none"
        disabled={disabled}
        maxLength={2000}
      />
    </div>
  )
}

// ── Link Field ──────────────────────────────────────────────────

function LinkField({
  icon,
  label,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl border border-border bg-muted/30 flex items-center justify-center shrink-0 text-muted-foreground">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <label className="text-[11px] font-semibold text-muted-foreground mb-1 block">{label}</label>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-9 rounded-xl border-border bg-transparent text-sm placeholder:text-muted-foreground/40"
          disabled={disabled}
        />
      </div>
      {value && (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="w-9 h-9 rounded-xl border border-border flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-4"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  )
}
