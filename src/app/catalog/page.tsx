/**
 * Component Catalog — living style guide for all Scholera UI components.
 *
 * Browse every component variant, color, state, and effect in one place.
 * This page lives outside the dashboard layout so it requires no auth.
 * Keep this page updated as new components are added or modified.
 *
 * Route: /catalog
 */
'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  BookOpen, Building2, Users, Plus, Trash2, Pencil, Search, ArrowRight,
  Loader2, AlertTriangle, CheckCircle, Info, X,
  ToggleRight, GraduationCap, Settings,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Breadcrumbs } from '@/components/ui/breadcrumbs'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { CapacityBar } from '@/components/ui/capacity-bar'
import { Toaster } from '@/components/ui/sonner'
import { cn } from '@/lib/utils'

/* ── Helpers ── */

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="flex items-center gap-3 mb-6">
        <h2 className="font-[family-name:var(--font-instrument-serif)] text-[24px] tracking-tight">{title}</h2>
        <div className="flex-1 h-px bg-border" />
      </div>
      {children}
    </section>
  )
}

function Swatch({ label, className }: { label: string; className: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className={cn('h-12 w-12 rounded-xl border border-border', className)} />
      <span className="text-[10px] text-muted-foreground font-mono">{label}</span>
    </div>
  )
}

function ComponentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">{label}</p>
      <div className="flex flex-wrap items-center gap-3">
        {children}
      </div>
    </div>
  )
}

/* ── Sidebar nav ── */

const NAV_SECTIONS = [
  { id: 'typography', label: 'Typography' },
  { id: 'colors', label: 'Colors' },
  { id: 'buttons', label: 'Buttons' },
  { id: 'badges', label: 'Badges' },
  { id: 'cards', label: 'Cards' },
  { id: 'status', label: 'Status Indicators' },
  { id: 'capacity', label: 'Capacity Bars' },
  { id: 'progress', label: 'Progress' },
  { id: 'inputs', label: 'Inputs & Forms' },
  { id: 'tabs', label: 'Tabs' },
  { id: 'tables', label: 'Tables' },
  { id: 'dialogs', label: 'Dialogs' },
  { id: 'dropdowns', label: 'Dropdowns' },
  { id: 'breadcrumbs', label: 'Breadcrumbs' },
  { id: 'toasts', label: 'Toasts' },
  { id: 'loading', label: 'Loading States' },
  { id: 'icons', label: 'Icon Containers' },
  { id: 'effects', label: 'Hover Effects' },
]

/* ── Page ── */

export default function CatalogPage() {
  const [activeSection, setActiveSection] = useState('typography')

  return (
    <div className="min-h-screen bg-background">
      <Toaster richColors position="top-right" />

      {/* Header */}
      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-md border-b border-border/50">
        <div className="max-w-[1400px] mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-7 w-7 rounded-lg bg-foreground flex items-center justify-center">
              <GraduationCap className="h-4 w-4 text-background" />
            </div>
            <span className="font-[family-name:var(--font-instrument-serif)] text-[20px] tracking-tight">
              Schol<em className="italic">era</em>
            </span>
            <span className="text-[11px] font-semibold px-3 py-1 rounded-full border border-border bg-muted/50 text-muted-foreground uppercase tracking-wider">
              Catalog
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Back to app
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto flex">
        {/* Sidebar nav */}
        <aside className="hidden lg:block w-56 shrink-0 sticky top-[57px] h-[calc(100vh-57px)] overflow-y-auto border-r border-border/50 py-6 px-4">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em] mb-3">Components</p>
          <nav className="space-y-0.5">
            {NAV_SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={() => setActiveSection(s.id)}
                className={cn(
                  'block px-3 py-1.5 text-sm rounded-lg transition-colors',
                  activeSection === s.id
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                {s.label}
              </a>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 px-6 lg:px-12 py-10 space-y-16">
          {/* Page header */}
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">Design System</p>
            <h1 className="font-[family-name:var(--font-instrument-serif)] text-[36px] tracking-tight">
              Component <em className="italic text-muted-foreground">Catalog</em>
            </h1>
            <p className="text-[15px] text-muted-foreground mt-2 max-w-xl">
              Every UI component, variant, color, and interaction pattern used across Scholera.
              This is a living reference — updated as components evolve.
            </p>
          </div>

          {/* ── Typography ── */}
          <Section id="typography" title="Typography">
            <div className="space-y-6">
              <div className="space-y-4">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">Headings — Instrument Serif</p>
                <h1 className="font-[family-name:var(--font-instrument-serif)] text-[36px] tracking-tight">Page Title — 36px</h1>
                <h2 className="font-[family-name:var(--font-instrument-serif)] text-[28px] tracking-tight">Section Heading — 28px</h2>
                <h3 className="font-[family-name:var(--font-instrument-serif)] text-[24px] tracking-tight">Card Title — 24px</h3>
                <h4 className="font-[family-name:var(--font-instrument-serif)] text-[20px] tracking-tight">Subsection — 20px</h4>
              </div>

              <div className="space-y-4">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">Heading with italic emphasis</p>
                <h1 className="font-[family-name:var(--font-instrument-serif)] text-[32px] tracking-tight">
                  Your courses. <em className="italic text-muted-foreground">At a glance.</em>
                </h1>
              </div>

              <div className="space-y-3">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">Body — Geist Sans</p>
                <p className="text-[15px] text-foreground">Primary body text — 15px, text-foreground</p>
                <p className="text-sm text-foreground">Secondary body text — 14px (text-sm)</p>
                <p className="text-sm text-muted-foreground">Muted text — text-muted-foreground</p>
                <p className="text-xs text-muted-foreground">Small caption — 12px (text-xs)</p>
              </div>

              <div className="space-y-3">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">Labels & Overlines</p>
                <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase">Section Label — 11px uppercase</p>
                <p className="text-[10px] font-medium text-muted-foreground/60 tracking-wider uppercase">Subtle overline — 10px</p>
              </div>

              <div className="space-y-3">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">Monospace</p>
                <p className="font-mono text-sm">font-mono — code, IDs, section codes</p>
                <span className="inline-flex items-center rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-sm font-mono font-semibold text-foreground">
                  CS-101
                </span>
              </div>

              <div className="space-y-3">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">Stat Numbers — Instrument Serif</p>
                <div className="flex gap-8">
                  <div>
                    <p className="font-[family-name:var(--font-instrument-serif)] text-[36px] leading-none">128</p>
                    <p className="text-xs text-muted-foreground mt-1">Students</p>
                  </div>
                  <div>
                    <p className="font-[family-name:var(--font-instrument-serif)] text-[28px] leading-none">24</p>
                    <p className="text-xs text-muted-foreground mt-1">Courses</p>
                  </div>
                </div>
              </div>
            </div>
          </Section>

          {/* ── Colors ── */}
          <Section id="colors" title="Colors">
            <div className="space-y-6">
              <ComponentRow label="Core Palette">
                <Swatch label="background" className="bg-background" />
                <Swatch label="foreground" className="bg-foreground" />
                <Swatch label="card" className="bg-card" />
                <Swatch label="muted" className="bg-muted" />
                <Swatch label="muted-fg" className="bg-muted-foreground" />
                <Swatch label="border" className="bg-border" />
              </ComponentRow>

              <ComponentRow label="Semantic">
                <Swatch label="primary" className="bg-primary" />
                <Swatch label="primary-fg" className="bg-primary-foreground" />
                <Swatch label="secondary" className="bg-secondary" />
                <Swatch label="accent" className="bg-accent" />
                <Swatch label="destructive" className="bg-destructive" />
              </ComponentRow>

              <ComponentRow label="Functional (used for semantic meaning)">
                <Swatch label="emerald-500" className="bg-emerald-500" />
                <Swatch label="amber-400" className="bg-amber-400" />
                <Swatch label="sky-400" className="bg-sky-400" />
                <Swatch label="destructive" className="bg-destructive" />
                <Swatch label="fg/40" className="bg-foreground/40" />
                <Swatch label="fg/20" className="bg-foreground/20" />
              </ComponentRow>

              <ComponentRow label="Chart Colors">
                <Swatch label="chart-1" className="bg-chart-1" />
                <Swatch label="chart-2" className="bg-chart-2" />
                <Swatch label="chart-3" className="bg-chart-3" />
                <Swatch label="chart-4" className="bg-chart-4" />
                <Swatch label="chart-5" className="bg-chart-5" />
              </ComponentRow>
            </div>
          </Section>

          {/* ── Buttons ── */}
          <Section id="buttons" title="Buttons">
            <div className="space-y-6">
              <ComponentRow label="Variants">
                <Button>Default</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="link">Link</Button>
                <Button variant="destructive">Destructive</Button>
              </ComponentRow>

              <ComponentRow label="Sizes">
                <Button size="xs">Extra Small</Button>
                <Button size="sm">Small</Button>
                <Button size="default">Default</Button>
                <Button size="lg">Large</Button>
              </ComponentRow>

              <ComponentRow label="Icon Buttons">
                <Button size="icon-xs"><Plus className="h-3 w-3" /></Button>
                <Button size="icon-sm"><Plus className="h-4 w-4" /></Button>
                <Button size="icon"><Plus className="h-4 w-4" /></Button>
                <Button size="icon-lg"><Plus className="h-5 w-5" /></Button>
              </ComponentRow>

              <ComponentRow label="With Icons">
                <Button><Plus className="h-4 w-4 mr-1.5" /> Add Item</Button>
                <Button variant="outline"><Search className="h-4 w-4 mr-1.5" /> Search</Button>
                <Button variant="destructive"><Trash2 className="h-4 w-4 mr-1.5" /> Delete</Button>
                <Button variant="secondary"><Pencil className="h-4 w-4 mr-1.5" /> Edit</Button>
              </ComponentRow>

              <ComponentRow label="States">
                <Button disabled>Disabled</Button>
                <Button disabled variant="outline">Disabled Outline</Button>
                <Button disabled variant="destructive">Disabled Destructive</Button>
              </ComponentRow>

              <ComponentRow label="Editorial Style (rounded-full)">
                <button className="px-8 py-3 rounded-full bg-primary text-primary-foreground text-[15px] font-semibold hover:scale-[1.02] active:scale-[0.98] transition-[background-color,transform] duration-300 shadow-sm">
                  Primary CTA
                </button>
                <button className="px-8 py-3 rounded-full border-[1.5px] border-border text-foreground text-[15px] font-semibold hover:bg-muted transition-colors duration-300">
                  Secondary CTA
                </button>
                <button className="group px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:scale-[1.02] active:scale-[0.98] transition-transform duration-300 inline-flex items-center gap-2">
                  Get Started <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
                </button>
              </ComponentRow>
            </div>
          </Section>

          {/* ── Badges ── */}
          <Section id="badges" title="Badges">
            <div className="space-y-6">
              <ComponentRow label="Variants">
                <Badge>Default</Badge>
                <Badge variant="secondary">Secondary</Badge>
                <Badge variant="outline">Outline</Badge>
                <Badge variant="destructive">Destructive</Badge>
                <Badge variant="ghost">Ghost</Badge>
              </ComponentRow>

              <ComponentRow label="Use Cases">
                <Badge variant="outline" className="font-mono">CS-101</Badge>
                <Badge variant="outline" className="font-normal">Assistant Professor</Badge>
                <Badge variant="secondary">Master&apos;s Degree</Badge>
                <Badge>Active</Badge>
                <Badge variant="destructive">Overdue</Badge>
              </ComponentRow>

              <ComponentRow label="Role Badges (header style)">
                <span className="text-[11px] font-semibold px-3 py-1 rounded-full border border-border bg-muted/50 text-muted-foreground uppercase tracking-wider">Admin</span>
                <span className="text-[11px] font-semibold px-3 py-1 rounded-full border border-border bg-muted/50 text-muted-foreground uppercase tracking-wider">Professor</span>
                <span className="text-[11px] font-semibold px-3 py-1 rounded-full border border-border bg-muted/50 text-muted-foreground uppercase tracking-wider">Student</span>
              </ComponentRow>

              <ComponentRow label="Count Pills (tab style)">
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/10 px-1.5 text-xs font-medium">12</span>
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary">5</span>
              </ComponentRow>
            </div>
          </Section>

          {/* ── Cards ── */}
          <Section id="cards" title="Cards">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Default Card</CardTitle>
                  <CardDescription>Uses rounded-2xl, border, shadow-sm by default.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">Card content goes here.</p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border">
                <CardContent className="pt-6 pb-5 space-y-4">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-sm font-mono font-semibold text-foreground">
                      CS
                    </span>
                    <h3 className="font-[family-name:var(--font-instrument-serif)] text-[24px] tracking-tight">Header Card Style</h3>
                  </div>
                  <p className="text-sm text-muted-foreground">Used for detail page headers with code badge + title.</p>
                  <div className="flex items-center gap-6 pt-2 border-t border-border">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                        <BookOpen className="h-4 w-4 text-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold leading-none">24</p>
                        <p className="text-xs text-muted-foreground">Courses</p>
                      </div>
                    </div>
                    <div className="h-8 w-px bg-border" />
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                        <Users className="h-4 w-4 text-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold leading-none">12</p>
                        <p className="text-xs text-muted-foreground">Faculty</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">With Footer</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">Card with action footer.</p>
                </CardContent>
                <CardFooter className="border-t pt-4">
                  <Button variant="outline" size="sm" className="ml-auto">Save Changes</Button>
                </CardFooter>
              </Card>

              <Card>
                <CardContent className="py-12">
                  <div className="text-center">
                    <Building2 className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-muted-foreground font-medium">Empty State</p>
                    <p className="text-sm text-muted-foreground mt-1">No items to display yet.</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </Section>

          {/* ── Status Indicators ── */}
          <Section id="status" title="Status Indicators">
            <div className="space-y-6">
              <ComponentRow label="All Statuses">
                <StatusIndicator status="active" />
                <StatusIndicator status="completed" />
                <StatusIndicator status="enrolled" />
                <StatusIndicator status="draft" />
                <StatusIndicator status="suspended" />
                <StatusIndicator status="on_leave" />
                <StatusIndicator status="inactive" />
                <StatusIndicator status="archived" />
                <StatusIndicator status="cancelled" />
                <StatusIndicator status="dropped" />
                <StatusIndicator status="withdrawn" />
              </ComponentRow>

              <ComponentRow label="Without Labels">
                <StatusIndicator status="active" showLabel={false} />
                <StatusIndicator status="draft" showLabel={false} />
                <StatusIndicator status="inactive" showLabel={false} />
                <StatusIndicator status="cancelled" showLabel={false} />
              </ComponentRow>

              <ComponentRow label="Custom Labels">
                <StatusIndicator status="active" label="Online" />
                <StatusIndicator status="inactive" label="Offline" />
                <StatusIndicator status="draft" label="Pending Review" />
              </ComponentRow>
            </div>
          </Section>

          {/* ── Capacity Bars ── */}
          <Section id="capacity" title="Capacity Bars">
            <div className="space-y-4 max-w-md">
              <ComponentRow label="Low fill (green)">
                <CapacityBar enrolled={8} max={30} />
              </ComponentRow>
              <ComponentRow label="Medium fill (amber, 70-90%)">
                <CapacityBar enrolled={24} max={30} />
              </ComponentRow>
              <ComponentRow label="High fill (red, >90%)">
                <CapacityBar enrolled={29} max={30} />
              </ComponentRow>
              <ComponentRow label="No cap">
                <CapacityBar enrolled={15} max={null} />
              </ComponentRow>
            </div>
          </Section>

          {/* ── Progress ── */}
          <Section id="progress" title="Progress">
            <div className="space-y-4 max-w-md">
              <ComponentRow label="Progress Bar">
                <div className="w-full space-y-3">
                  <Progress value={0} />
                  <Progress value={25} />
                  <Progress value={50} />
                  <Progress value={75} />
                  <Progress value={100} />
                </div>
              </ComponentRow>
            </div>
          </Section>

          {/* ── Inputs ── */}
          <Section id="inputs" title="Inputs & Forms">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-4">
                <ComponentRow label="Text Input">
                  <div className="w-full space-y-2">
                    <Label htmlFor="demo-input">Email address</Label>
                    <Input id="demo-input" type="email" placeholder="name@example.com" />
                  </div>
                </ComponentRow>

                <ComponentRow label="Input with icon hint">
                  <div className="relative w-full">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input className="pl-9" placeholder="Search courses..." />
                  </div>
                </ComponentRow>

                <ComponentRow label="Disabled Input">
                  <Input disabled placeholder="Disabled" className="w-full" />
                </ComponentRow>
              </div>

              <div className="space-y-4">
                <ComponentRow label="Textarea">
                  <div className="w-full space-y-2">
                    <Label htmlFor="demo-textarea">Description</Label>
                    <Textarea id="demo-textarea" placeholder="Enter description..." rows={3} />
                  </div>
                </ComponentRow>

                <ComponentRow label="Select">
                  <div className="w-full space-y-2">
                    <Label>Semester</Label>
                    <Select>
                      <SelectTrigger>
                        <SelectValue placeholder="Select semester" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fall">Fall 2026</SelectItem>
                        <SelectItem value="spring">Spring 2026</SelectItem>
                        <SelectItem value="summer">Summer 2026</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </ComponentRow>
              </div>
            </div>
          </Section>

          {/* ── Tabs ── */}
          <Section id="tabs" title="Tabs">
            <div className="space-y-8">
              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">Pill-style tabs (default)</p>
                <Tabs defaultValue="overview" className="w-full">
                  <TabsList className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground gap-1">
                    <TabsTrigger
                      value="overview"
                      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                    >
                      Overview
                    </TabsTrigger>
                    <TabsTrigger
                      value="courses"
                      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                    >
                      <BookOpen className="h-3.5 w-3.5" />
                      Courses
                      <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted-foreground/10 px-1.5 text-xs font-medium">12</span>
                    </TabsTrigger>
                    <TabsTrigger
                      value="settings"
                      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                    >
                      <Settings className="h-3.5 w-3.5" />
                      Settings
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="overview" className="mt-4">
                    <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">Overview tab content</p></CardContent></Card>
                  </TabsContent>
                  <TabsContent value="courses" className="mt-4">
                    <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">Courses tab content</p></CardContent></Card>
                  </TabsContent>
                  <TabsContent value="settings" className="mt-4">
                    <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">Settings tab content</p></CardContent></Card>
                  </TabsContent>
                </Tabs>
              </div>

              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.15em]">Default shadcn tabs</p>
                <Tabs defaultValue="tab1">
                  <TabsList>
                    <TabsTrigger value="tab1">Tab One</TabsTrigger>
                    <TabsTrigger value="tab2">Tab Two</TabsTrigger>
                    <TabsTrigger value="tab3">Tab Three</TabsTrigger>
                  </TabsList>
                  <TabsContent value="tab1" className="mt-4">
                    <p className="text-sm text-muted-foreground">Content for tab one.</p>
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </Section>

          {/* ── Tables ── */}
          <Section id="tables" title="Tables">
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Credits</TableHead>
                      <TableHead>Enrollment</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-mono text-xs text-muted-foreground">CS-101</TableCell>
                      <TableCell className="font-medium">Intro to Computer Science</TableCell>
                      <TableCell><StatusIndicator status="active" /></TableCell>
                      <TableCell>3</TableCell>
                      <TableCell><CapacityBar enrolled={24} max={30} /></TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-mono text-xs text-muted-foreground">CS-201</TableCell>
                      <TableCell className="font-medium">Data Structures</TableCell>
                      <TableCell><StatusIndicator status="active" /></TableCell>
                      <TableCell>4</TableCell>
                      <TableCell><CapacityBar enrolled={28} max={30} /></TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-mono text-xs text-muted-foreground">CS-301</TableCell>
                      <TableCell className="font-medium">Algorithms</TableCell>
                      <TableCell><StatusIndicator status="draft" /></TableCell>
                      <TableCell>3</TableCell>
                      <TableCell><CapacityBar enrolled={0} max={25} /></TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </Section>

          {/* ── Dialogs ── */}
          <Section id="dialogs" title="Dialogs">
            <div className="flex flex-wrap gap-3">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">Default Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Dialog Title</DialogTitle>
                    <DialogDescription>This is a description of what this dialog does.</DialogDescription>
                  </DialogHeader>
                  <div className="py-4">
                    <p className="text-sm text-muted-foreground">Dialog content. Uses rounded-2xl corners.</p>
                  </div>
                  <DialogFooter>
                    <Button variant="outline">Cancel</Button>
                    <Button>Confirm</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="destructive">Delete Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Are you sure?</DialogTitle>
                    <DialogDescription>This action cannot be undone. This will permanently delete the item.</DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline">Cancel</Button>
                    <Button variant="destructive"><Trash2 className="h-4 w-4 mr-1.5" /> Delete</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Dialog>
                <DialogTrigger asChild>
                  <Button>Form Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add New Course</DialogTitle>
                    <DialogDescription>Fill in the details to create a new course.</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="dialog-code">Course Code</Label>
                      <Input id="dialog-code" placeholder="CS-101" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="dialog-title">Title</Label>
                      <Input id="dialog-title" placeholder="Introduction to..." />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline">Cancel</Button>
                    <Button>Create Course</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </Section>

          {/* ── Dropdowns ── */}
          <Section id="dropdowns" title="Dropdowns">
            <div className="flex flex-wrap gap-3">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">Actions Menu</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem><Pencil className="h-4 w-4 mr-2" /> Edit</DropdownMenuItem>
                  <DropdownMenuItem><ToggleRight className="h-4 w-4 mr-2" /> Set Active</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive">
                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </Section>

          {/* ── Breadcrumbs ── */}
          <Section id="breadcrumbs" title="Breadcrumbs">
            <div className="space-y-4">
              <Breadcrumbs items={[
                { label: 'Admin', href: '/admin' },
                { label: 'Departments', href: '/admin/departments' },
                { label: 'Computer Science' },
              ]} />
              <Breadcrumbs items={[
                { label: 'Professor', href: '/professor' },
                { label: 'Courses', href: '/professor/courses' },
                { label: 'CS-101 — Intro to CS', href: '/professor/courses/abc' },
                { label: 'Quizzes' },
              ]} />
            </div>
          </Section>

          {/* ── Toasts ── */}
          <Section id="toasts" title="Toasts">
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={() => toast.success('Course created successfully')}>
                <CheckCircle className="h-4 w-4 mr-1.5" /> Success Toast
              </Button>
              <Button variant="outline" onClick={() => toast.error('Failed to delete course')}>
                <X className="h-4 w-4 mr-1.5" /> Error Toast
              </Button>
              <Button variant="outline" onClick={() => toast.warning('Section is nearing capacity')}>
                <AlertTriangle className="h-4 w-4 mr-1.5" /> Warning Toast
              </Button>
              <Button variant="outline" onClick={() => toast.info('Quiz auto-saved')}>
                <Info className="h-4 w-4 mr-1.5" /> Info Toast
              </Button>
              <Button variant="outline" onClick={() => toast.loading('Saving changes...')}>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Loading Toast
              </Button>
            </div>
          </Section>

          {/* ── Loading States ── */}
          <Section id="loading" title="Loading States">
            <div className="space-y-6">
              <ComponentRow label="Spinner Button">
                <Button disabled>
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Saving...
                </Button>
                <Button variant="outline" disabled>
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Loading...
                </Button>
                <Button variant="destructive" disabled>
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Deleting...
                </Button>
              </ComponentRow>

              <ComponentRow label="Standalone Spinner">
                <Loader2 className="h-5 w-5 animate-spin text-foreground" />
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <Loader2 className="h-8 w-8 animate-spin text-foreground" />
              </ComponentRow>

              <ComponentRow label="Skeleton Placeholders">
                <div className="space-y-3 w-full max-w-sm">
                  <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-full rounded bg-muted animate-pulse" />
                  <div className="h-4 w-1/2 rounded bg-muted animate-pulse" />
                </div>
              </ComponentRow>

              <ComponentRow label="Card Skeleton">
                <Card className="w-full max-w-sm">
                  <CardContent className="pt-6 space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-xl bg-muted animate-pulse" />
                      <div className="space-y-2 flex-1">
                        <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
                        <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
                      </div>
                    </div>
                    <div className="h-px bg-border" />
                    <div className="flex gap-6">
                      <div className="h-8 w-16 rounded bg-muted animate-pulse" />
                      <div className="h-8 w-16 rounded bg-muted animate-pulse" />
                    </div>
                  </CardContent>
                </Card>
              </ComponentRow>
            </div>
          </Section>

          {/* ── Icon Containers ── */}
          <Section id="icons" title="Icon Containers">
            <div className="space-y-6">
              <ComponentRow label="Monochrome (default)">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                  <BookOpen className="h-4 w-4 text-foreground" />
                </div>
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50">
                  <Users className="h-5 w-5 text-foreground" />
                </div>
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50">
                  <Building2 className="h-6 w-6 text-foreground" />
                </div>
              </ComponentRow>

              <ComponentRow label="Avatar / Initials">
                <span className="inline-flex items-center justify-center rounded-xl border border-border bg-muted/50 h-10 w-10 text-sm font-mono font-semibold text-foreground">JD</span>
                <span className="inline-flex items-center justify-center rounded-xl border border-border bg-muted/50 h-10 w-10 text-sm font-mono font-semibold text-foreground">AB</span>
                <span className="inline-flex items-center justify-center rounded-xl border border-border bg-muted/50 h-10 w-10 text-sm font-mono font-semibold text-foreground">?</span>
              </ComponentRow>

              <ComponentRow label="Code Badges">
                <span className="inline-flex items-center rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-sm font-mono font-semibold text-foreground">CS</span>
                <span className="inline-flex items-center rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-sm font-mono font-semibold text-foreground">MATH</span>
                <span className="inline-flex items-center rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-sm font-mono font-semibold text-foreground">ENG</span>
              </ComponentRow>

              <ComponentRow label="Semantic Icon Containers (for functional meaning)">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50">
                  <CheckCircle className="h-5 w-5 text-emerald-600" />
                </div>
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50">
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                </div>
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                  <X className="h-5 w-5 text-destructive" />
                </div>
              </ComponentRow>

              <ComponentRow label="Brand Logo">
                <div className="h-7 w-7 rounded-lg bg-foreground flex items-center justify-center">
                  <GraduationCap className="h-4 w-4 text-background" />
                </div>
                <div className="h-9 w-9 rounded-lg bg-foreground flex items-center justify-center">
                  <GraduationCap className="h-5 w-5 text-background" />
                </div>
              </ComponentRow>
            </div>
          </Section>

          {/* ── Hover Effects ── */}
          <Section id="effects" title="Hover Effects">
            <div className="space-y-6">
              <ComponentRow label="Card Lift (hover me)">
                <div className="rounded-2xl border border-border bg-card p-6 hover:-translate-y-1 transition-transform duration-500 hover:shadow-lg cursor-pointer">
                  <p className="text-sm font-medium">Lift on hover</p>
                  <p className="text-xs text-muted-foreground mt-1">-translate-y-1 + shadow-lg</p>
                </div>
                <div className="rounded-2xl border border-border bg-card p-6 hover:-translate-y-2 transition-transform duration-500 hover:shadow-2xl cursor-pointer">
                  <p className="text-sm font-medium">Bigger lift</p>
                  <p className="text-xs text-muted-foreground mt-1">-translate-y-2 + shadow-2xl</p>
                </div>
              </ComponentRow>

              <ComponentRow label="Scale Micro-interaction (hover me)">
                <button className="px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:scale-[1.02] active:scale-[0.98] transition-transform duration-300">
                  hover:scale-[1.02]
                </button>
                <button className="px-6 py-3 rounded-full border border-border text-sm font-semibold hover:scale-105 active:scale-95 transition-transform duration-300">
                  hover:scale-105
                </button>
              </ComponentRow>

              <ComponentRow label="Icon Scale in Container (hover me)">
                <div className="group rounded-2xl border border-border bg-card p-6 cursor-pointer hover:-translate-y-1 transition-transform duration-500">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/50 group-hover:scale-110 transition-transform duration-500">
                    <BookOpen className="h-6 w-6 text-foreground" />
                  </div>
                  <p className="text-sm font-medium mt-3">Icon scales on parent hover</p>
                </div>
              </ComponentRow>

              <ComponentRow label="Border Highlight (hover me)">
                <div className="rounded-2xl border border-border bg-card p-6 cursor-pointer hover:border-foreground transition-colors duration-300">
                  <p className="text-sm font-medium">Border darkens on hover</p>
                </div>
                <div className="rounded-2xl border-[1.5px] border-border bg-card p-6 cursor-pointer hover:border-foreground transition-colors duration-300">
                  <p className="text-sm font-medium">Thicker border variant</p>
                </div>
              </ComponentRow>

              <ComponentRow label="Row Hover (see table above)">
                <p className="text-sm text-muted-foreground">Tables use hover:bg-muted/50 on rows.</p>
              </ComponentRow>
            </div>
          </Section>

          {/* Footer */}
          <div className="border-t border-border pt-8 pb-12 text-center">
            <p className="text-[11px] font-semibold text-muted-foreground tracking-[0.2em] uppercase mb-2">Scholera Design System</p>
            <p className="text-sm text-muted-foreground">
              Editorial monochrome theme — Instrument Serif + Geist Sans, pure neutral palette, generous whitespace.
            </p>
          </div>
        </main>
      </div>
    </div>
  )
}
