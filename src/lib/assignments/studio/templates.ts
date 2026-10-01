/**
 * Assignment Studio — template catalogue (Milestone 1).
 *
 * Templates are plain, code-defined presets that *seed the existing manual
 * wizard* — they never gate creation behind anything. Manual creation stays
 * fully possible (the "Blank" template, and every field remains editable after
 * a template is picked). No DB, no migration: this is static config.
 *
 * Later milestones extend `AssignmentTemplate` with a `blocks` document for the
 * studio shell; M1 only needs the wizard prefill.
 */
import { BarChart3, FileText, FilePlus2, Network, type LucideIcon } from 'lucide-react'
import type { FileTypeKind } from '@/lib/validations/assignment'
import type { TemplatePrefill } from '@/components/professor/assignments/CreateAssignmentWizard'

export type TemplateId = 'data-analysis' | 'er-diagram' | 'proposal-report' | 'blank'

export interface AssignmentTemplate {
  id: TemplateId
  title: string
  subtitle: string
  icon: LucideIcon
  prefill: TemplatePrefill
}

const DATA_ANALYSIS_SCAFFOLD = `## Dataset
Briefly describe the dataset students will work with and where to find it.

## Tasks
1. Load and clean the data.
2. Explore and visualize the key relationships.
3. Summarize what you found.

## What to submit
Your notebook (zipped) and a short PDF write-up of your conclusions.`

const ER_DIAGRAM_SCAFFOLD = `## Scenario
Describe the system or domain students will model.

## What to design
Create an entity-relationship (or system) diagram that captures the entities,
attributes, and relationships in the scenario above.

## What to submit
Export your diagram as an image or PDF and upload it here.`

const PROPOSAL_REPORT_SCAFFOLD = `## Prompt
Describe the topic or question this report should address.

## Structure
- Introduction and motivation
- Main body / analysis
- Conclusion and next steps

## What to submit
Upload your report as a Word document or PDF.`

export const ASSIGNMENT_TEMPLATES: AssignmentTemplate[] = [
  {
    id: 'data-analysis',
    title: 'Data Analysis Lab',
    subtitle: 'Dataset plus guided analysis questions students work through.',
    icon: BarChart3,
    prefill: {
      title: 'Data Analysis Lab',
      instructions: DATA_ANALYSIS_SCAFFOLD,
      fileTypes: ['pdf', 'zip'] satisfies FileTypeKind[],
    },
  },
  {
    id: 'er-diagram',
    title: 'ER / Diagram',
    subtitle: 'An entity-relationship or system diagram students design.',
    icon: Network,
    prefill: {
      title: 'ER Diagram',
      instructions: ER_DIAGRAM_SCAFFOLD,
      fileTypes: ['image', 'pdf'] satisfies FileTypeKind[],
    },
  },
  {
    id: 'proposal-report',
    title: 'Proposal / Report',
    subtitle: 'A written proposal or report submitted as a document.',
    icon: FileText,
    prefill: {
      title: 'Proposal / Report',
      instructions: PROPOSAL_REPORT_SCAFFOLD,
      fileTypes: ['doc', 'pdf'] satisfies FileTypeKind[],
    },
  },
  {
    id: 'blank',
    title: 'Blank',
    subtitle: 'Start from scratch and set everything yourself.',
    icon: FilePlus2,
    prefill: {},
  },
]
