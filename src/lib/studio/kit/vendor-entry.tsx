/**
 * The entry for /studio-runtime/v1/vendor.js: React, React DOM and the plugin kit, built
 * once and committed (scripts/studio/build-runtime-vendor.mjs). Pinned per bridge
 * version: rule 8.7 says a plugin built against v1 keeps working, so v1's vendor file
 * never changes. A test checks the committed file against VENDOR_V1_SHA256.
 *
 * It defines one frozen global, `ScholeraKit`. Plugin bundles use it instead of
 * bundling React, so they hold only the plugin's own code: what the validator scans.
 */
import { createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  Button,
  Card,
  Checkbox,
  Empty,
  ErrorState,
  Heading,
  Loading,
  makeUseRequest,
  Screen,
  Stack,
  Text,
  TextField,
} from './components'

type StudioGlobal = { request: (method: string, args?: unknown) => Promise<unknown> }

// `ScholeraStudio` is defined by runtime.js at the welcome, before any plugin code runs.
const request = (method: string, args?: unknown) =>
  (window as unknown as { ScholeraStudio: StudioGlobal }).ScholeraStudio.request(method, args)

let root: Root | null = null

/** Mounts the plugin's screen into the frame. Once per frame. */
function render(element: ReturnType<typeof createElement>) {
  const container = document.getElementById('root')
  if (!container) throw new Error('The plugin root is missing.')
  root ??= createRoot(container)
  root.render(element)
}

const kit = Object.freeze({
  version: 'v1',
  h: createElement,
  Fragment,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  render,
  request,
  useRequest: makeUseRequest(request),
  Screen,
  Stack,
  Card,
  Heading,
  Text,
  Button,
  TextField,
  Checkbox,
  Loading,
  Empty,
  ErrorState,
})

Object.defineProperty(window, 'ScholeraKit', { value: kit, writable: false, configurable: false })
