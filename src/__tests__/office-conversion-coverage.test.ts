// @vitest-environment node
//
// Office → PDF conversion and the Docker image have to agree, and nothing else
// checks it.
//
// This test used to assert the OPPOSITE of what it asserts now, and the flip is
// the point. While conversion ran in-process, LibreOffice's per-application
// import filters had to be installed for every extension OFFICE_EXTS accepted —
// declaring `docx` without `libreoffice-writer` produced a container that took
// the upload, failed the conversion, and turned the material into a permanently
// retrying job. A dev machine carries the full `libreoffice` metapackage, so
// that gap passed both the unit tests and a real local end-to-end run.
//
// Issue #182 moved conversion out of the app image entirely, into the isolated
// Gotenberg service (infra/microservices/deck-converter/). A crafted PPTX can
// make LibreOffice resolve external links; in-process that reads the app
// container's own metadata endpoint and internal services, and pins its CPU
// inside a request. So the invariant inverted: the packages must now be ABSENT.
//
// Nothing else enforces that. Adding `libreoffice-writer` back to the Dockerfile
// to "fix" a conversion would silently undo the security fix and still pass every
// other test in the suite, because in-process conversion works — that is exactly
// what makes it dangerous. This file is the tripwire.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { isRenderableSource } from '@/lib/document-parser/asset-crop'

const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8')

/** Lines that actually install packages, ignoring prose in comments. */
const installLines = dockerfile
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')

describe('Office conversion coverage', () => {
  it('ships no LibreOffice package in the app image (issue #182)', () => {
    // Any libreoffice-* package, plus the bare metapackage and the `soffice`
    // binary an alternative install route would bring.
    const found = ['libreoffice', 'soffice'].filter((pkg) => installLines.includes(pkg))
    expect(found).toEqual([])
  })

  it('keeps the fonts, which are not LibreOffice’s', () => {
    // pdfjs rasterization falls back to system fonts for PDFs that embed none,
    // and the metric-compatible pair stops a rendered page reflowing. Deleting
    // these along with LibreOffice is the easy mistake in the other direction.
    expect(installLines).toContain('fonts-crosextra-carlito')
    expect(installLines).toContain('fonts-crosextra-caladea')
  })

  it('routes every convertible extension through the converter, not in-process', () => {
    // Everything isRenderableSource accepts beyond PDF needs conversion, and the
    // only conversion path left is convertOfficeToPdf → Gotenberg. Asserted as a
    // property of the module rather than a package list: the service ships the
    // full LibreOffice filter set, so the app-side question is no longer "is the
    // filter installed" but "is there any way to convert without leaving here".
    const convertible = ['ppt', 'pptx', 'docx'].filter((e) => isRenderableSource(`x.${e}`))
    expect(convertible.length).toBeGreaterThan(0)

    const converter = readFileSync(
      join(process.cwd(), 'src/lib/live-classroom/deck-converter.ts'),
      'utf8',
    )
    expect(converter).toContain('/forms/libreoffice/convert')
    // Unset GOTENBERG_URL must refuse, not silently fall back to a local binary.
    expect(converter).toContain('isPptxEnabled')
  })

  it('does not accept an extension whose filter nobody ships', () => {
    // The inverse guard: something like .odp or .rtf added to the set without
    // checking would convert on a developer's full install and nowhere else.
    for (const ext of ['odp', 'odt', 'rtf', 'pages', 'key']) {
      expect(isRenderableSource(`lecture.${ext}`)).toBe(false)
    }
  })

  it('still treats a file with no pages as unrenderable', () => {
    for (const ext of ['mp4', 'png', 'zip', 'txt']) {
      expect(isRenderableSource(`x.${ext}`)).toBe(false)
    }
  })

  it('renders PDFs directly, with no conversion package needed', () => {
    expect(isRenderableSource('notes.pdf')).toBe(true)
  })
})
