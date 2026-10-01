/**
 * CertificatesPanel — Professor UI to define challenge-milestone certificates.
 *
 * Dead-simple setup (Gate 2): name it, optionally describe it, check the
 * challenges that must ALL be completed. Completing the full set issues a
 * shareable credential to the student.
 *
 * Type: Client Component
 */
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Award, Plus, Trash2, GraduationCap, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EmptyState } from '@/components/ui/empty-state'
import { AnimatedList, AnimatedItem } from '@/components/ui/animated-list'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  createCertificate,
  updateCertificate,
  deleteCertificate,
} from '@/app/(dashboard)/professor/courses/[sectionId]/challenges/actions'

interface CertificateItem {
  id: string
  title: string
  description: string
  is_active: boolean
  challenge_ids: string[]
  earned_count: number
}

interface ChallengeOption {
  id: string
  title: string
  visibility: string
}

interface CertificatesPanelProps {
  sectionId: string
  certificates: CertificateItem[]
  challenges: ChallengeOption[]
}

export function CertificatesPanel({ sectionId, certificates, challenges }: CertificatesPanelProps) {
  // Only non-archived challenges can compose a new certificate.
  const options = challenges.filter((c) => c.visibility !== 'archived')

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Certificates</h3>
          <p className="text-xs text-muted-foreground">
            Bundle challenges into a milestone. Finishing them all earns students a shareable certificate.
          </p>
        </div>
        <CreateCertificateDialog sectionId={sectionId} options={options} />
      </div>

      {certificates.length === 0 ? (
        <EmptyState
          icon={GraduationCap}
          title="No certificates yet"
          description="Create a certificate above to reward students who complete a set of challenges — they can share it on LinkedIn."
        />
      ) : (
        <AnimatedList className="space-y-3">
          {certificates.map((cert) => (
            <AnimatedItem key={cert.id}>
              <CertificateCard sectionId={sectionId} cert={cert} />
            </AnimatedItem>
          ))}
        </AnimatedList>
      )}
    </div>
  )
}

// ── Create dialog ───────────────────────────────────────────────

function CreateCertificateDialog({
  sectionId,
  options,
}: {
  sectionId: string
  options: ChallengeOption[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const q = query.trim().toLowerCase()
  const visible = q ? options.filter((c) => c.title.toLowerCase().includes(q)) : options

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function reset() {
    setTitle('')
    setDescription('')
    setSelected(new Set())
    setQuery('')
  }

  async function handleSubmit() {
    if (!title.trim()) {
      toast.error('Give the certificate a title')
      return
    }
    if (selected.size === 0) {
      toast.error('Pick at least one challenge')
      return
    }
    setIsSubmitting(true)
    try {
      const result = await createCertificate(sectionId, {
        title: title.trim(),
        description: description.trim(),
        challenge_ids: Array.from(selected),
      })
      if ('error' in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success('Certificate created')
      setOpen(false)
      reset()
      router.refresh()
    } catch {
      toast.error('Something went wrong')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset() }}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          disabled={options.length === 0}
          title={options.length === 0 ? 'Create a challenge first — certificates bundle existing challenges.' : undefined}
        >
          <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
          New certificate
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Certificate</DialogTitle>
          <DialogDescription>
            Students who complete every challenge below earn this certificate.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cert-title">Title *</Label>
            <Input
              id="cert-title"
              placeholder="e.g. Data Analysis Master"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cert-desc">Description</Label>
            <Textarea
              id="cert-desc"
              placeholder="What this milestone represents…"
              className="resize-none"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </div>
          <div className="space-y-2">
            <Label>Challenges *</Label>
            {options.length === 0 ? (
              <p className="text-sm text-muted-foreground">Create some challenges first.</p>
            ) : (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    placeholder="Search challenges…"
                    className="pl-8"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <ScrollArea className="h-48 rounded-md border border-border p-2">
                  {visible.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm text-muted-foreground">No challenges match “{query}”.</p>
                  ) : (
                    <div className="space-y-1">
                      {visible.map((c) => (
                        <label
                          key={c.id}
                          htmlFor={`cert-ch-${c.id}`}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted cursor-pointer"
                        >
                          <Checkbox
                            id={`cert-ch-${c.id}`}
                            checked={selected.has(c.id)}
                            onCheckedChange={() => toggle(c.id)}
                          />
                          <span className="text-sm truncate">{c.title}</span>
                          {c.visibility === 'draft' && (
                            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">draft</span>
                          )}
                        </label>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </>
            )}
            <p className="text-xs text-muted-foreground">{selected.size} selected</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? 'Creating…' : 'Create Certificate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Certificate card ────────────────────────────────────────────

function CertificateCard({ sectionId, cert }: { sectionId: string; cert: CertificateItem }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function handleToggleActive(next: boolean) {
    setBusy(true)
    try {
      const result = await updateCertificate(cert.id, sectionId, { is_active: next })
      if ('error' in result && result.error) { toast.error(result.error); return }
      toast.success(next ? 'Certificate active' : 'Certificate paused')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    const result = await deleteCertificate(cert.id, sectionId)
    if ('error' in result && result.error) { toast.error(result.error); return }
    toast.success('Certificate deleted')
    router.refresh()
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Award className="h-4 w-4 text-muted-foreground shrink-0" />
            <h4 className="text-sm font-semibold truncate">{cert.title}</h4>
          </div>
          {cert.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{cert.description}</p>
          )}
          <p className="text-xs text-muted-foreground mt-2 tabular-nums">
            {cert.challenge_ids.length} challenge{cert.challenge_ids.length === 1 ? '' : 's'} · {cert.earned_count} earned
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            <Switch
              checked={cert.is_active}
              onCheckedChange={handleToggleActive}
              disabled={busy}
              aria-label="Certificate active"
            />
            <span className="text-xs text-muted-foreground">{cert.is_active ? 'Active' : 'Paused'}</span>
          </div>
          {/* Once earned, a certificate is an immutable credential — it can only
              be paused (Active toggle), never deleted. So delete is offered only
              while earned_count is 0. */}
          {cert.earned_count === 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive-muted h-8 w-8 p-0"
                  aria-label="Delete certificate"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this certificate?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes the certificate definition. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    variant="destructive"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </div>
  )
}
