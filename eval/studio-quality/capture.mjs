// Screenshot evidence for the generation-quality judge (Step 12A). Reads
// { manifest, studentBundle, professorBundle, sample, outDir } as JSON on stdin, writes JPEGs
// into outDir and prints { shots, failures } as JSON on stdout. Spawned by capture.ts with a
// minimal environment, like the builder's renderer.
//
// It goes through the Stage 2 runner's servers and host page (runner.mjs): the real frame
// document and policy, the real runtime and kit of the manifest's bridge version, the real
// host with the preview bridge and the synthetic class, Chromium's sandbox on, and every
// request to anything but the two local origins blocked. It never touches render.mjs, the
// builder's own renderer.
//
// Render evidence: after each screenshot, what the page actually shows, read from the live
// DOM and its accessibility attributes (headings, text, buttons, controls and their labels,
// tabs, table headers, badges, alerts, states, options), with each element's visibility and a
// structural locator. The normal desktop state also opens each tab. All of it goes to
// render.json beside the screenshots.
//
// Shots: the normal state of both views at desktop and phone width (the required ones), and
// both views at desktop width with no data (empty), while loading (slow) and when every
// request fails (failing). Each is the whole frame as it lays out, not cut at a fixed
// height. The frame itself is capped at STUDIO_FRAME_MAX_HEIGHT_PX by the host; a view
// taller than that is marked truncated.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { openScenario, startServers, waitFor } from '../../validator-runtime/runner.mjs'

const INPUT_MAX_BYTES = 3 * 1024 * 1024
const VIEWPORT_HEIGHT = 900
const QUALITY = 80
const TIMEOUT_MS = 180_000
const DEVICES = { desktop: 1280, phone: 390 }
const SHOTS = [
  { view: 'professor', device: 'desktop', scenario: 'normal' },
  { view: 'professor', device: 'phone', scenario: 'normal' },
  { view: 'student', device: 'desktop', scenario: 'normal' },
  { view: 'student', device: 'phone', scenario: 'normal' },
  { view: 'professor', device: 'desktop', scenario: 'empty' },
  { view: 'student', device: 'desktop', scenario: 'empty' },
  { view: 'professor', device: 'desktop', scenario: 'slow' },
  { view: 'student', device: 'desktop', scenario: 'slow' },
  { view: 'professor', device: 'desktop', scenario: 'failing' },
  { view: 'student', device: 'desktop', scenario: 'failing' },
]
const STATE = { empty: 'empty', slow: 'loading', failing: 'error' }
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const RENDER_FORMAT = 'studio-quality-render-v1'
const MAX_TABS = 6

/**
 * What a person can actually see in one document, read from the live DOM and its
 * accessibility attributes: never OCR, never the source. Runs inside the page (Playwright
 * serialises it, so it uses nothing from outside). `rootSelector` limits it to Scholera's
 * mount in the host page, where the roster overlay is drawn; in the plugin frame it reads the
 * whole body. An element that isn't laid out (display none, zero size, hidden, or under
 * aria-hidden) is not recorded: nothing invisible is inferred.
 */
function readRenderedDom({ rootSelector, frameName, offset }) {
  const root = rootSelector ? document.querySelector(rootSelector) : document.body
  if (!root) return { items: [], truncated: 0 }
  const MAX_ITEMS = 220
  const MAX_TEXT = 200
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const squash = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
  const cut = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)
  const textOf = (el) => squash(el.innerText ?? el.textContent)
  const laidOut = (el) => {
    if (el.closest('[aria-hidden="true"]')) return false
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  // How much of the element shows across, after every clipping ancestor and the frame's width.
  const visibility = (el) => {
    const r = el.getBoundingClientRect()
    let left = Math.max(r.left, 0)
    let right = Math.min(r.right, vw)
    let scroller = false
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const st = getComputedStyle(a)
      if (st.overflowX !== 'visible') {
        const ar = a.getBoundingClientRect()
        left = Math.max(left, ar.left)
        right = Math.min(right, ar.right)
        if (a.scrollWidth > a.clientWidth + 1) scroller = true
      }
    }
    const shown = r.width > 0 ? Math.max(0, right - left) / r.width : 0
    if (r.top >= vh) return 'below-frame'
    if (shown >= 0.95) return 'visible'
    if (shown > 0.05) return scroller ? 'partly-scrolled' : 'clipped'
    return scroller ? 'scrolled-out' : 'offscreen'
  }
  const textCut = (el) => {
    const st = getComputedStyle(el)
    return st.overflow !== 'visible' && (el.scrollWidth > el.clientWidth + 1 || st.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth)
  }
  const step = (el) => {
    const kit = [...el.classList].find((c) => c.startsWith('kit-') && !/^kit-(tone|size|weight|cell)-/.test(c))
    const same = el.parentElement ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName) : []
    const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : ''
    return `${el.tagName.toLowerCase()}${kit ? `.${kit}` : ''}${nth}`
  }
  const locator = (el) => {
    const parts = []
    for (let a = el; a && a !== root && parts.length < 6; a = a.parentElement) parts.unshift(step(a))
    return parts.join('>')
  }
  const GROUPS = '.kit-card, .kit-list-item, tr, .kit-state, form, fieldset, [role="dialog"], .kit-section, table, .kit-screen'
  const groupOf = (el) => {
    const g = el.parentElement?.closest(GROUPS)
    return g && root.contains(g) ? locator(g) : null
  }
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return squash(aria)
    const by = el.getAttribute('aria-labelledby')
    if (by) return squash(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (l) return textOf(l)
    }
    const wrap = el.closest('label')
    return wrap ? textOf(wrap) : ''
  }

  const items = []
  let truncated = 0
  const consumed = new Set()
  // `consume` keeps the element's own text from being read again as plain text.
  const add = (el, kind, extra, consume = true) => {
    if (items.length >= MAX_ITEMS) {
      truncated += 1
      return
    }
    const r = el.getBoundingClientRect()
    items.push({
      frame: frameName,
      kind,
      ...extra,
      text: cut(extra.text ?? ''),
      visibility: visibility(el),
      textCut: textCut(el),
      group: groupOf(el),
      locator: `${frameName}:${locator(el)}`,
      rect: { x: Math.round(r.left + offset.x), y: Math.round(r.top + offset.y), w: Math.round(r.width), h: Math.round(r.height) },
    })
    if (consume) consumed.add(el)
  }
  const inside = (el) => {
    for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) if (consumed.has(a)) return true
    return false
  }
  const all = (sel) => [...root.querySelectorAll(sel)].filter((el) => laidOut(el))

  for (const el of all('[data-kit-state]')) add(el, 'state', { state: el.getAttribute('data-kit-state'), text: textOf(el) })
  for (const el of all('h1, h2, h3, h4, h5, h6, [role="heading"]')) add(el, 'heading', { text: textOf(el), level: Number(el.tagName.slice(1)) || Number(el.getAttribute('aria-level')) || null })
  for (const el of all('[role="tab"]')) add(el, 'tab', { text: textOf(el), selected: el.getAttribute('aria-selected') === 'true' })
  for (const el of all('[role="radio"], [role="option"]')) {
    const group = el.closest('[role="radiogroup"], [role="listbox"]')
    add(el, 'option', { text: textOf(el) || labelOf(el), selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true', label: group ? labelOf(group) : '' })
  }
  for (const el of all('button, [role="button"], [role="switch"], input[type="button"], input[type="submit"], input[type="reset"]')) {
    if (consumed.has(el)) continue
    add(el, 'button', {
      text: textOf(el) || el.value || '',
      label: el.getAttribute('aria-label') ? squash(el.getAttribute('aria-label')) : '',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      ...(el.hasAttribute('aria-pressed') ? { selected: el.getAttribute('aria-pressed') === 'true' } : {}),
      ...(el.getAttribute('role') === 'switch' ? { selected: el.getAttribute('aria-checked') === 'true' } : {}),
    })
  }
  for (const el of all('a[href]')) add(el, 'link', { text: textOf(el), label: labelOf(el) })
  for (const el of all('input, textarea, select')) {
    if (consumed.has(el) || el.type === 'hidden') continue
    const control = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type || 'text'
    const extra = { text: labelOf(el), label: labelOf(el), control, placeholder: squash(el.getAttribute('placeholder')), disabled: el.disabled === true }
    if (control === 'checkbox' || control === 'radio') extra.selected = el.checked
    if (el.tagName === 'SELECT') {
      const options = [...el.options].filter((o) => !o.disabled || o.selected)
      extra.value = squash(el.selectedOptions[0]?.textContent ?? '')
      extra.options = options.map((o) => squash(o.textContent)).filter(Boolean).slice(0, 20)
    }
    add(el, 'control', extra)
  }
  for (const el of all('table')) {
    // Column headers only: a row header (a student's name in the roster) is part of its row.
    const headers = [...el.querySelectorAll('thead th, th[scope="col"]')].filter((th, i, all) => all.indexOf(th) === i && laidOut(th)).map((th) => textOf(th) || squash(th.getAttribute('aria-label')))
    const bodyRows = [...el.querySelectorAll('tbody tr')].filter((tr) => laidOut(tr))
    add(el, 'table', {
      text: headers.join(' | '),
      label: squash(el.getAttribute('aria-label') || el.querySelector('caption')?.textContent || el.closest('[role="region"]')?.getAttribute('aria-label') || ''),
      headers,
      rowCount: bodyRows.length,
      rows: bodyRows.slice(0, 4).map((tr) => [...tr.children].map((c) => textOf(c) || squash(c.getAttribute('aria-label') ?? ''))),
    })
  }
  for (const el of all('.kit-badge')) if (!consumed.has(el)) add(el, 'badge', { text: textOf(el) })
  for (const el of all('.kit-stat')) add(el, 'stat', { text: textOf(el) })
  for (const el of all('[role="alert"], [role="status"], .kit-alert')) if (!el.hasAttribute('data-kit-state') && !inside(el)) add(el, 'alert', { text: textOf(el) })
  for (const el of all('[role="progressbar"]')) add(el, 'progress', { text: labelOf(el), value: Number(el.getAttribute('aria-valuenow')), max: Number(el.getAttribute('aria-valuemax')) })
  for (const el of all('figure, [role="img"]')) if (!inside(el)) add(el, 'chart', { text: textOf(el), label: labelOf(el) })
  for (const el of all('ul, ol')) if (!inside(el)) add(el, 'list', { text: '', label: labelOf(el), rowCount: [...el.children].filter((c) => laidOut(c)).length }, false)
  // Text that no element above already accounts for: the leaf blocks a reader actually reads.
  for (const el of all('p, span, li, dt, dd, label, blockquote, td, strong, em, small, div')) {
    if (inside(el) || consumed.has(el)) continue
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    if (!own) continue
    const text = textOf(el)
    if (text) add(el, 'text', { text })
  }
  items.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  return { items, truncated }
}

/** Both documents a person sees: the plugin frame, and the host's roster overlay over it. */
async function readRendered(s) {
  const frame = s.frame()
  const offset = await s.page.evaluate(() => {
    const f = document.querySelector('#mount iframe')?.getBoundingClientRect()
    return f ? { x: f.left, y: f.top } : { x: 0, y: 0 }
  })
  const inFrame = frame ? await frame.evaluate(readRenderedDom, { rootSelector: null, frameName: 'plugin', offset }) : { items: [], truncated: 0 }
  const overlay = await s.page.evaluate(readRenderedDom, { rootSelector: '#mount', frameName: 'host', offset: { x: 0, y: 0 } })
  // Which document an item came from is decided here, not by code running in the plugin's frame.
  const items = [...inFrame.items.map((i) => ({ ...i, frame: 'plugin' })), ...overlay.items.map((i) => ({ ...i, frame: 'host' }))].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  return { items, truncated: inFrame.truncated + overlay.truncated }
}

/** One screen's rendered evidence, or a marked failure: a page that can't be read fails only itself. */
async function readOrFail(s) {
  try {
    return await readRendered(s)
  } catch {
    return { items: [], truncated: 0, failed: true }
  }
}

const chunks = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > INPUT_MAX_BYTES) process.exit(2)
  chunks.push(chunk)
}
const raw = Buffer.concat(chunks)
// Echoed back, so the caller can check these screenshots are of exactly what it sent.
const inputSha256 = createHash('sha256').update(raw).digest('hex')
let input
try {
  input = JSON.parse(raw.toString('utf8'))
} catch {
  process.exit(2)
}
if (
  !isPlainObject(input) ||
  !isPlainObject(input.manifest) ||
  typeof input.studentBundle !== 'string' ||
  typeof input.professorBundle !== 'string' ||
  typeof input.outDir !== 'string' ||
  !(input.sample === null || input.sample === undefined || isPlainObject(input.sample))
) {
  process.exit(2)
}

async function capture() {
  const artifact = { manifest: input.manifest, studentBundle: input.studentBundle, professorBundle: input.professorBundle }
  mkdirSync(input.outDir, { recursive: true })
  const servers = await startServers(artifact)
  const browser = await chromium.launch({ chromiumSandbox: true })
  const killer = setTimeout(() => browser.close().catch(() => {}), TIMEOUT_MS)
  const shots = []
  const failures = []
  const renders = []
  try {
    for (const shot of SHOTS) {
      const id = `${shot.view}-${shot.device}-${shot.scenario}`
      const width = DEVICES[shot.device]
      const s = await openScenario(browser, servers, artifact, shot.view, shot.scenario, { width, height: VIEWPORT_HEIGHT }, {
        sample: input.sample ?? null,
        className: 'render-frame',
      })
      try {
        await s.page.emulateMedia({ reducedMotion: 'reduce' })
        const ready = await waitFor(async () => (await s.snapshot())?.status === 'ready', 10_000)
        if (!ready) {
          failures.push({ id, reason: (await s.snapshot())?.reason ?? 'not_ready' })
          continue
        }
        const hasState = (state) => async () => {
          const frame = s.frame()
          return frame ? frame.evaluate((sel) => !!document.querySelector(sel), `[data-kit-state="${state}"]`) : false
        }
        if (shot.scenario === 'normal') {
          // Let the first reads land and the frame settle at its content height.
          await waitFor(async () => !(await hasState('loading')()), 4_000)
          await s.page.waitForTimeout(600)
        } else {
          // Screenshot whatever is there; whether the state appeared is recorded either way.
          await waitFor(hasState(STATE[shot.scenario]), shot.scenario === 'slow' ? 2_000 : 6_000)
          if (shot.scenario !== 'slow') await s.page.waitForTimeout(400)
        }
        const after = await s.snapshot()
        if (after?.status !== 'ready') {
          failures.push({ id, reason: after?.reason ?? 'not_ready' })
          continue
        }
        const stateShown = shot.scenario === 'normal' ? null : await hasState(STATE[shot.scenario])()
        const frame = s.frame()
        const content = frame ? await frame.evaluate(() => ({ scroll: document.documentElement.scrollHeight, client: document.documentElement.clientHeight })) : null
        const height = await s.page.evaluate(() => Math.ceil(document.getElementById('mount').getBoundingClientRect().height))
        const file = `${id}.jpg`
        const bytes = await s.page.screenshot({ type: 'jpeg', quality: QUALITY, fullPage: true, clip: { x: 0, y: 0, width, height: Math.max(height, 160) } })
        writeFileSync(join(input.outDir, file), bytes)
        shots.push({
          id,
          file,
          view: shot.view,
          device: shot.device,
          width,
          scenario: shot.scenario,
          height: Math.max(height, 160),
          truncated: content ? content.scroll > content.client + 2 : false,
          stateShown,
        })
        // What is actually on screen, read after the screenshot so reading can't change the image.
        renders.push({ shot: id, view: shot.view, device: shot.device, scenario: shot.scenario, width, tab: null, ...(await readOrFail(s)) })
        if (shot.scenario === 'normal' && shot.device === 'desktop' && frame) {
          // A tab's content exists only once it is chosen: open each one, so nothing behind a
          // tab is mistaken for missing. Desktop only, after the screenshot.
          const tabs = frame.locator('[role="tab"]')
          const count = Math.min(await tabs.count().catch(() => 0), MAX_TABS)
          const shownFirst = await tabs.evaluateAll((all) => all.map((t) => t.getAttribute('aria-selected') === 'true')).catch(() => [])
          for (let i = 0; i < count; i++) {
            const tab = tabs.nth(i)
            if (shownFirst[i]) continue
            const label = ((await tab.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
            try {
              await tab.click({ timeout: 2_000 })
              await waitFor(async () => !(await hasState('loading')()), 3_000)
              await s.page.waitForTimeout(400)
              renders.push({ shot: id, view: shot.view, device: shot.device, scenario: shot.scenario, width, tab: label, ...(await readOrFail(s)) })
            } catch {
              renders.push({ shot: id, view: shot.view, device: shot.device, scenario: shot.scenario, width, tab: label, items: [], truncated: 0, failed: true })
            }
          }
        }
      } finally {
        await s.context.close()
      }
    }
  } finally {
    clearTimeout(killer)
    await browser.close().catch(() => {})
    servers.close()
  }
  writeFileSync(join(input.outDir, 'render.json'), `${JSON.stringify({ format: RENDER_FORMAT, shots: renders })}\n`)
  return { shots, failures, render: 'render.json' }
}

try {
  const result = await capture()
  process.stdout.write(JSON.stringify({ ...result, inputSha256 }), () => process.exit(0))
} catch {
  process.exit(1)
}
