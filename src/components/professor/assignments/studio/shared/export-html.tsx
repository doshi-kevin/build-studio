/**
 * Notebook HTML export — renders a notebook to a self-contained, print-friendly .html document
 * (the browser's "Save as PDF" turns it into a PDF). Markdown/math/chemistry via
 * react-dom/server + StudioMarkdown; code in <pre>. KaTeX CSS is linked from a CDN so math is
 * styled when the file is opened online.
 *
 * The print scaffold (`wrapPrintableHtml`) is shared with the document export, which lives in its
 * own module (`document-html.ts`) so this file stays free of the editor/novel import chain that
 * the notebook unit tests can't transform.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import type { StudioNotebook } from '@/lib/assignments/studio/notebook-model'
import { getAuthoring } from '@/lib/assignments/studio/authoring'
import { StudioMarkdown } from './StudioMarkdown'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function notebookToHtml(nb: StudioNotebook, title: string): string {
  // language_info.name is attacker-controllable (imported .ipynb); guard the type before it's
  // escaped and interpolated into the data-lang attribute, falling back cleanly to 'python'.
  const rawLang = (nb.metadata?.language_info as Record<string, unknown> | undefined)?.name
  const lang = typeof rawLang === 'string' ? rawLang : 'python'

  const body = nb.cells
    .map((c) => {
      const a = getAuthoring(c.metadata)
      const pts = a.points !== undefined ? `<p class="pts">${a.points} pts</p>` : ''
      if (c.cell_type === 'markdown') {
        return `<section>${pts}${renderToStaticMarkup(<StudioMarkdown content={c.source} />)}</section>`
      }
      if (c.cell_type === 'code') {
        return `<section>${pts}<pre class="code" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(c.source)}</code></pre></section>`
      }
      return `<section><pre>${escapeHtml(c.source)}</pre></section>`
    })
    .join('\n')

  return wrapPrintableHtml(title, body)
}

/** Wrap rendered body HTML in a self-contained, print-friendly document (shared by both exports).
 *
 * Print trigger strategy: the inline script runs on load, AFTER KaTeX auto-renders math and AFTER
 * all images are decoded (eager loading + Promise.allSettled(img.decode())). This fixes the bug
 * where Chrome skips lazy-loaded or in-flight images when window.print() fires too early.
 * DownloadDocumentButton just opens the tab — it no longer calls print() itself. */
export function wrapPrintableHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css">
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #18181b; }
  h1 { font-size: 1.6rem; }
  pre.code, pre { background: #f4f4f5; padding: .75rem; border-radius: .5rem; overflow-x: auto; }
  .pts { font-size: .8rem; color: #71717a; margin: 0 0 .25rem; }
  section { margin: 1rem 0; }
  img { max-width: 100%; }
  ul, ol { padding-left: 1.5rem; }
  blockquote { border-left: 3px solid #d4d4d8; margin: 1rem 0; padding-left: 1rem; color: #52525b; }
  figure.block-export { margin: 1.25rem 0; text-align: center; }
  figure.block-export figcaption { font-size: .9rem; font-weight: 600; color: #18181b; margin-bottom: .4rem; }
  .solver-export { border: 1px solid #e4e4e7; border-radius: .5rem; padding: .75rem 1rem; margin: 1.25rem 0; }
  .solver-h { font-size: .85rem; font-weight: 600; color: #4b56d2; margin: 0 0 .4rem; }
  .solver-body { background: #f8f8fb; white-space: pre-wrap; padding: .5rem .75rem; border-radius: .4rem; }
  .map-note { color: #71717a; font-size: .85rem; font-style: italic; }
  [data-callout] { border-left: 4px solid #4b56d2; background: #f5f6fe; border-radius: .5rem; padding: .6rem .9rem; margin: 1rem 0; }
  [data-callout][data-variant="tip"] { border-left-color: #12805c; background: #f0faf5; }
  [data-callout][data-variant="warning"] { border-left-color: #c0453b; background: #fdf3f2; }
  [data-callout] p { margin: 0; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/contrib/mhchem.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]});printWhenReady()"></script>
<script>
// Trigger print only after KaTeX has rendered AND every image is decoded.
// Chrome skips loading="lazy" images not yet scrolled into view when print() fires early.
function printWhenReady() {
  var imgs = Array.from(document.images);
  imgs.forEach(function(img) { img.loading = 'eager'; });
  Promise.allSettled(imgs.map(function(img) { return img.decode().catch(function(){}); })).then(function() {
    window.focus();
    window.print();
  });
}
// Fallback: if auto-render script fails to load, print anyway after a grace period.
window.addEventListener('load', function() {
  if (typeof window.printWhenReady !== 'undefined') return;
  setTimeout(function() { window.focus(); window.print(); }, 1200);
});
window.printWhenReady = printWhenReady;
</script>
</body>
</html>`
}
