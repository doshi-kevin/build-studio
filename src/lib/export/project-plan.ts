// Exports a project plan as PDF or DOCX. Uses dynamic imports so jspdf/docx
// don't bloat the initial bundle. Called client-side from ExportProjectPlanButton.

// ── Shared data interface ──────────────────────────────────────

export interface ProjectExportData {
  project: {
    title: string
    description?: string
    guidelines?: string
    status: string
    due_date?: string | null
    max_team_size?: number
  }
  team: {
    name: string
    description?: string
    planning_doc?: string
  }
  members: Array<{
    name: string
    email: string
    role: string
  }>
  phases: Array<{
    title: string
    description?: string
    status: string
    start_date?: string | null
    due_date?: string | null
    position: number
    items?: Array<{
      title: string
      is_completed: boolean
    }>
  }>
  grade?: {
    score: number
    feedback?: string
  } | null
}

// ── Helpers ────────────────────────────────────────────────────


function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _-]/g, '').trim()
}

// ── PDF Export ─────────────────────────────────────────────────
// Exports only the planning document content — renders TipTap HTML as a clean PDF.

export async function exportProjectPlanAsPdf(data: ProjectExportData): Promise<void> {
  const { jsPDF } = await import('jspdf')

  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 20
  const contentWidth = pageWidth - margin * 2
  let y = margin

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - margin) {
      doc.addPage()
      y = margin
    }
  }

  // Parse TipTap HTML and render each element with appropriate jsPDF styles
  const renderHtml = (html: string) => {
    const parser = new DOMParser()
    const parsed = parser.parseFromString(`<div>${html}</div>`, 'text/html')
    const root = parsed.querySelector('div')
    if (!root) return

    const processEl = (el: Element) => {
      const tag = el.tagName.toLowerCase()

      if (tag === 'h1') {
        const text = (el.textContent || '').trim()
        if (!text) return
        ensureSpace(16)
        y += 4
        doc.setFontSize(22)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(15, 15, 30)
        for (const l of doc.splitTextToSize(text, contentWidth)) {
          ensureSpace(12); doc.text(l, margin, y); y += 12
        }
        y += 2
      } else if (tag === 'h2') {
        const text = (el.textContent || '').trim()
        if (!text) return
        ensureSpace(12)
        y += 3
        doc.setFontSize(16)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(20, 20, 35)
        for (const l of doc.splitTextToSize(text, contentWidth)) {
          ensureSpace(9); doc.text(l, margin, y); y += 9
        }
        y += 1
      } else if (tag === 'h3') {
        const text = (el.textContent || '').trim()
        if (!text) return
        ensureSpace(10)
        y += 2
        doc.setFontSize(13)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(25, 25, 40)
        for (const l of doc.splitTextToSize(text, contentWidth)) {
          ensureSpace(7); doc.text(l, margin, y); y += 7
        }
      } else if (tag === 'p') {
        const text = (el.textContent || '').trim()
        if (!text) { y += 4; return }
        ensureSpace(6)
        doc.setFontSize(11)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(40, 40, 55)
        for (const l of doc.splitTextToSize(text, contentWidth)) {
          ensureSpace(6); doc.text(l, margin, y); y += 6
        }
        y += 2
      } else if (tag === 'ul' || tag === 'ol') {
        y += 1
        let idx = 1
        for (const li of Array.from(el.children)) {
          if (li.tagName.toLowerCase() !== 'li') continue
          const text = (li.textContent || '').trim()
          if (!text) { y += 3; idx++; continue }
          ensureSpace(6)
          doc.setFontSize(11)
          doc.setFont('helvetica', 'normal')
          doc.setTextColor(40, 40, 55)
          const prefix = tag === 'ol' ? `${idx}.` : '-'
          doc.text(prefix, margin + 2, y)
          const wrapped = doc.splitTextToSize(text, contentWidth - 9)
          for (let j = 0; j < wrapped.length; j++) {
            if (j > 0) ensureSpace(6)
            doc.text(wrapped[j], margin + 9, y)
            y += 6
          }
          idx++
        }
        y += 2
      } else if (tag === 'blockquote') {
        const text = (el.textContent || '').trim()
        if (!text) return
        ensureSpace(6)
        doc.setFontSize(11)
        doc.setFont('helvetica', 'italic')
        doc.setTextColor(100, 100, 115)
        doc.setDrawColor(200, 200, 210)
        doc.line(margin + 1, y - 4, margin + 1, y + 2)
        for (const l of doc.splitTextToSize(text, contentWidth - 8)) {
          ensureSpace(6); doc.text(l, margin + 6, y); y += 6
        }
        y += 2
      } else {
        // div or other container — recurse into children
        for (const child of Array.from(el.children)) processEl(child)
      }
    }

    for (const child of Array.from(root.children)) processEl(child)
  }

  if (data.team.planning_doc) {
    renderHtml(data.team.planning_doc)
  }

  doc.save(`${sanitizeFilename(data.project.title)} - Planning Document.pdf`)
}

// ── DOCX Export ────────────────────────────────────────────────
// Exports only the planning document content — renders TipTap HTML as a clean Word document.

export async function exportProjectPlanAsDocx(data: ProjectExportData): Promise<void> {
  const {
    Document,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    Packer,
  } = await import('docx')
  const { saveAs } = await import('file-saver')

  const children: InstanceType<typeof Paragraph>[] = []

  // Parse TipTap HTML and convert each element to docx Paragraph nodes
  const renderHtml = (html: string) => {
    const parser = new DOMParser()
    const parsed = parser.parseFromString(`<div>${html}</div>`, 'text/html')
    const root = parsed.querySelector('div')
    if (!root) return

    const processEl = (el: Element) => {
      const tag = el.tagName.toLowerCase()

      if (tag === 'h1') {
        const text = (el.textContent || '').trim()
        if (!text) return
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text, bold: true, size: 44, color: '0F0F1E' })],
        }))
      } else if (tag === 'h2') {
        const text = (el.textContent || '').trim()
        if (!text) return
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 80 },
          children: [new TextRun({ text, bold: true, size: 32, color: '141423' })],
        }))
      } else if (tag === 'h3') {
        const text = (el.textContent || '').trim()
        if (!text) return
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 160, after: 60 },
          children: [new TextRun({ text, bold: true, size: 26, color: '191928' })],
        }))
      } else if (tag === 'p') {
        const text = (el.textContent || '').trim()
        children.push(new Paragraph({
          spacing: { after: text ? 120 : 60 },
          children: [new TextRun({ text, size: 22, color: '282837' })],
        }))
      } else if (tag === 'ul') {
        for (const li of Array.from(el.children)) {
          if (li.tagName.toLowerCase() !== 'li') continue
          const text = (li.textContent || '').trim()
          children.push(new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60 },
            children: [new TextRun({ text, size: 22, color: '282837' })],
          }))
        }
      } else if (tag === 'ol') {
        for (const li of Array.from(el.children)) {
          if (li.tagName.toLowerCase() !== 'li') continue
          const text = (li.textContent || '').trim()
          children.push(new Paragraph({
            numbering: { reference: 'default-numbering', level: 0 },
            spacing: { after: 60 },
            children: [new TextRun({ text, size: 22, color: '282837' })],
          }))
        }
      } else if (tag === 'blockquote') {
        const text = (el.textContent || '').trim()
        if (!text) return
        children.push(new Paragraph({
          alignment: AlignmentType.LEFT,
          indent: { left: 720 },
          spacing: { after: 120 },
          children: [new TextRun({ text, size: 22, color: '646478', italics: true })],
        }))
      } else {
        for (const child of Array.from(el.children)) processEl(child)
      }
    }

    for (const child of Array.from(root.children)) processEl(child)
  }

  if (data.team.planning_doc) {
    renderHtml(data.team.planning_doc)
  }

  const docxDoc = new Document({
    title: `${data.project.title} - Planning Document`,
    creator: 'Scholera',
    numbering: {
      config: [
        {
          reference: 'default-numbering',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text: '%1.',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
        },
        children,
      },
    ],
  })

  const blob = await Packer.toBlob(docxDoc)
  saveAs(blob, `${sanitizeFilename(data.project.title)} - Planning Document.docx`)
}
