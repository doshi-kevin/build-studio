/**
 * The plugin frame document: its HTML and its security headers. Pure and import-free,
 * so the Next.js route and the browser isolation tests (e2e/studio-runtime) run exactly
 * the same code. docs/reference/studio-plugin-runtime.md explains each directive.
 *
 * The plugin bundle is placed in the document as inert text (type="text/plain"). The
 * runtime executes it only after the host's welcome, which the host sends only after the
 * frame's first load event. So plugin code can't navigate before the host is counting
 * load events, and every self-navigation is detected (rules appendix N9).
 *
 * Load order: runtime.js first (it removes channels the policy can't cover before any
 * other code exists), then vendor.js (React and the plugin kit, Scholera's own pinned
 * code), then, after the welcome, the plugin bundle, which holds only plugin code.
 */

export const RUNTIME_PATH = '/studio-runtime/v1/'
export const BUNDLE_ELEMENT_ID = 'studio-plugin-bundle'

export interface FrameDocumentInput {
  /** Scholera's origin: the only page allowed to frame this document. */
  appOrigin: string
  /** The dedicated plugin origin this document is served from. */
  runtimeOrigin: string
  /** Fresh per response, base64. Authorizes exactly one script: the plugin bundle. */
  nonce: string
  bundle: string
  title: string
}

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/
const NONCE = /^[A-Za-z0-9+/]{16,}={0,2}$/

function check(input: FrameDocumentInput) {
  if (!ORIGIN.test(input.appOrigin) || !ORIGIN.test(input.runtimeOrigin)) throw new Error('studio frame: invalid origin')
  if (!NONCE.test(input.nonce)) throw new Error('studio frame: invalid nonce')
}

/** Deny everything, then allow only the runtime and vendor scripts, the bundle's nonce,
 * and the runtime's own stylesheet and fonts. `sandbox` repeats the iframe attribute, so
 * the document is sandboxed even if opened directly or framed without the attribute. */
export function frameCsp({ appOrigin, runtimeOrigin, nonce }: Pick<FrameDocumentInput, 'appOrigin' | 'runtimeOrigin' | 'nonce'>) {
  const runtime = `${runtimeOrigin}${RUNTIME_PATH}`
  return [
    "default-src 'none'",
    `script-src ${runtime}runtime.js ${runtime}vendor.js 'nonce-${nonce}'`,
    `style-src ${runtime}`,
    `font-src ${runtime}fonts/`,
    "img-src 'none'",
    "media-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // Named explicitly: 'self' is ambiguous for a document the sandbox makes opaque.
    `frame-ancestors ${appOrigin}`,
    'sandbox allow-scripts',
  ].join('; ')
}

// Every powerful feature off. The iframe's empty `allow` attribute does the same from the
// host's side; this covers the document however it is loaded.
const PERMISSIONS_POLICY = [
  'accelerometer', 'autoplay', 'bluetooth', 'camera', 'clipboard-read', 'clipboard-write',
  'display-capture', 'encrypted-media', 'fullscreen', 'gamepad', 'geolocation', 'gyroscope',
  'hid', 'idle-detection', 'magnetometer', 'microphone', 'midi', 'payment',
  'picture-in-picture', 'publickey-credentials-get', 'screen-wake-lock', 'serial', 'usb',
  'web-share', 'xr-spatial-tracking',
].map((feature) => `${feature}=()`).join(', ')

export function frameHeaders(input: FrameDocumentInput): Record<string, string> {
  check(input)
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': frameCsp(input),
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
    'Cache-Control': 'no-store',
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Keeps the bundle inside its script element: a "</script" or "<!--" in plugin code
 * can't close the element or change how the HTML parser reads it. */
export const escapeScriptText = (code: string) =>
  // Keeps the original case: plugin strings that contain "</SCRIPT" must not change.
  code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')

export function frameHtml(input: FrameDocumentInput): string {
  check(input)
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.title)}</title>`,
    `<link rel="stylesheet" href="${input.runtimeOrigin}${RUNTIME_PATH}kit.css">`,
    '</head><body><div id="root"></div>',
    `<script src="${input.runtimeOrigin}${RUNTIME_PATH}runtime.js"></script>`,
    `<script src="${input.runtimeOrigin}${RUNTIME_PATH}vendor.js"></script>`,
    `<script type="text/plain" id="${BUNDLE_ELEMENT_ID}" nonce="${input.nonce}">${escapeScriptText(input.bundle)}</script>`,
    '</body></html>',
  ].join('')
}
