/**
 * The entry for /studio-runtime/v2/vendor.js: React, React DOM and the v2 plugin kit,
 * built once and committed (scripts/studio/build-runtime-vendor.mjs v2). Pinned like
 * v1: a test checks the committed file against VENDOR_V2_SHA256.
 *
 * It defines one frozen global, `ScholeraKit`, whose members are exactly what
 * plugin-kit-types.ts lets a view import (a test pins the two together).
 */
import { createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { makeUseRequest } from '../components'
import {
  Alert,
  Badge,
  BarChart,
  Button,
  Card,
  Checkbox,
  DataTable,
  DateField,
  Divider,
  Empty,
  ErrorState,
  formatDate,
  Grid,
  Heading,
  List,
  ListItem,
  Loading,
  makeUseRecords,
  makeUseRoster,
  NumberField,
  ProgressBar,
  RosterTable,
  Screen,
  SearchField,
  Section,
  SegmentedControl,
  Select,
  Stack,
  StatCard,
  Switch,
  Tabs,
  Text,
  TextField,
  today,
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

const useRequest = makeUseRequest(request)

const kit = Object.freeze({
  version: 'v2',
  h: createElement,
  Fragment,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  render,
  request,
  useRequest,
  useRecords: makeUseRecords(request),
  useRoster: makeUseRoster(useRequest),
  today,
  formatDate,
  Screen,
  Section,
  Card,
  Stack,
  Grid,
  Divider,
  Heading,
  Text,
  Badge,
  StatCard,
  DataTable,
  List,
  ListItem,
  ProgressBar,
  BarChart,
  RosterTable,
  Button,
  SegmentedControl,
  TextField,
  NumberField,
  DateField,
  SearchField,
  Select,
  Checkbox,
  Switch,
  Tabs,
  Alert,
  Loading,
  Empty,
  ErrorState,
})

Object.defineProperty(window, 'ScholeraKit', { value: kit, writable: false, configurable: false })
