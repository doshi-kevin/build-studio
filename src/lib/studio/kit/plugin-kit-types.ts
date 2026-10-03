/**
 * The plugin environment as the builder's typecheck sees it: hand-written, trusted
 * declarations for the two modules a plugin may import and the few globals it may use.
 *
 * The typecheck runs with `noLib`, so these declarations are the entire world. There is
 * no DOM, no `window`, no `fetch`, no Node and nothing of Scholera's: code that reaches
 * for any of them fails to typecheck. That is developer feedback, not the security
 * boundary. The sandbox, its security policy, the Bridge and the server still are.
 *
 * This is the v2 kit, which every draft is built against (v2 is a superset of v1, so a
 * v1 draft upgrades on its next build). Every importable name is a member of the frozen
 * `ScholeraKit` global that vendor.js v2 defines (kit/v2/vendor-entry.tsx). A test pins
 * the two lists together, and another pins the Bridge method names to the catalog.
 *
 * Pure and import-free on purpose: the check worker bundles it.
 */

/** What a view may import, by module. Each name binds to `ScholeraKit[name]` (kit v2). */
export const KIT_IMPORTS = {
  react: ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'Fragment'],
  '@scholera/plugin-kit': [
    'Screen', 'Section', 'Card', 'Stack', 'Grid', 'Divider', 'Heading', 'Text',
    'Badge', 'StatCard', 'DataTable', 'List', 'ListItem', 'ProgressBar', 'BarChart', 'RosterTable',
    'Button', 'SegmentedControl', 'Tabs', 'TextField', 'NumberField', 'DateField', 'SearchField', 'Select', 'Checkbox', 'Switch',
    'Alert', 'Loading', 'Empty', 'ErrorState',
    'request', 'useRequest', 'useRecords', 'useRoster', 'today', 'formatDate',
  ],
} as const satisfies Record<string, readonly string[]>

/** Types the kit declares. Importing one binds nothing at run time. */
export const KIT_TYPE_NAMES = [
  'PluginRecord', 'PluginContext', 'RequestState', 'BridgeMethod',
  'Tone', 'RosterCell', 'RecordsState', 'RecordChange', 'RosterState',
] as const

export type KitModule = keyof typeof KIT_IMPORTS
export type KitImportName = (typeof KIT_IMPORTS)[KitModule][number]
export const KIT_IMPORTABLE_NAMES = [...KIT_IMPORTS.react, ...KIT_IMPORTS['@scholera/plugin-kit']] as [KitImportName, ...KitImportName[]]

/** The Bridge methods a view may name. Kept equal to METHOD_CATALOG by a test. */
export const BRIDGE_METHOD_NAMES = [
  'context.get', 'course.skills', 'course.roster', 'course.assignments',
  'records.list', 'records.get', 'records.create', 'records.update', 'records.delete', 'records.batch',
  'ui.resize', 'ui.toast',
] as const

/**
 * What `get_kit_reference` returns for each name, and what the builder's instructions
 * list: props, when to reach for it, and a line of usage. The model writes from these,
 * so they decide how generated tools look.
 */
export const KIT_REFERENCE: Record<KitImportName, string> = {
  useState: 'useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]. React state. Import from "react".',
  useEffect: 'useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void. Import from "react". Load data with useRecords or useRequest, not an effect.',
  useMemo: 'useMemo<T>(factory: () => T, deps: readonly unknown[]): T. Import from "react". For derived data: totals, filtered lists, a Map from student handle to record.',
  useCallback: 'useCallback<T>(fn: T, deps: readonly unknown[]): T. Import from "react".',
  useRef: 'useRef<T>(initial: T): { current: T }. Import from "react". There are no DOM nodes to reference.',
  Fragment: 'Fragment: groups children without a wrapper. Import from "react", or write <>...</>.',

  Screen: 'Screen({ title?: string, description?: string, actions?: node, width?: "normal" | "wide", children }). The root of every view: exactly one, at the top. title is the page heading, description one muted sentence under it, actions the page-level buttons (top right). width "wide" (72rem) for dashboards and tables, "normal" (48rem) for forms and reading. Children are spaced for you.',
  Section: 'Section({ title?: string, description?: string, actions?: node, children }). A titled region of a screen ("Today", "All submissions"). Two to four sections give a screen its structure; a section\'s own buttons go in actions.',
  Card: 'Card({ title?: string, description?: string, actions?: node, tone?: Tone, children }). A bordered panel for one item, one form or one group of settings. tone tints it: "info" for guidance, "success" | "warning" | "danger" for status. Don\'t nest cards; don\'t wrap a DataTable or List in one (they have their own border).',
  Stack: 'Stack({ direction?: "row" | "column", gap?: "xsmall" | "small" | "medium" | "large", align?: "start" | "center" | "end" | "stretch", justify?: "start" | "between" | "end", wrap?: boolean, children }). Flex layout; default column with medium gap. Rows wrap and centre vertically by default. justify="between" pushes a label and a button apart; justify="end" for a form\'s buttons.',
  Grid: 'Grid({ columns: 1 | 2 | 3 | 4, gap?: "xsmall" | "small" | "medium" | "large", children }). Equal columns that collapse on small screens (one column under 640px, at most two under 960px). For a row of StatCards or a set of Cards.',
  Divider: 'Divider(). A hairline between groups inside a Card or Section.',
  Heading: 'Heading({ level?: 2 | 3, children }). A standalone heading. Prefer the title prop of Screen, Section or Card.',
  Text: 'Text({ tone?: "default" | "muted" | "success" | "warning" | "danger", size?: "small" | "medium" | "large", weight?: "regular" | "medium" | "bold", children }). A paragraph. muted for secondary details, small for metadata, a tone for a status sentence.',

  Badge: 'Badge({ tone?: Tone, children }). A short status label: "Submitted", "Late", "3 left". Tone is "neutral" (default) | "info" | "success" | "warning" | "danger". A few words only. In a DataTable cell or a ListItem meta.',
  StatCard: 'StatCard({ label: string, value: string | number, hint?: string, tone?: Tone }). One headline number: <StatCard label="Present today" value={12} hint="of 28 students" />. Put two to four in a Grid at the top of a professor view, so the summary comes before the detail. tone colours the number.',
  DataTable: 'DataTable({ label: string, columns: { key: string, header: string, align?: "start" | "center" | "end" }[], rows: { key: string, cells: Record<string, node> }[], emptyText?: string }). Records as a table; a cell holds text, a number, a Badge or a Button. align "end" for numbers. It scrolls sideways inside its own box on phones. Example: <DataTable label="Questions" columns={[{ key: "q", header: "Question" }, { key: "votes", header: "Votes", align: "end" }]} rows={items.map((r) => ({ key: r.id, cells: { q: r.data.text, votes: r.data.votes } }))} />. Student names never appear here: only RosterTable shows them.',
  List: 'List({ label?: string, children }). A bordered list of ListItem rows, for items that read better as rows than as a table: announcements, tasks, questions.',
  ListItem: 'ListItem({ title: string, description?: string, meta?: node, actions?: node }). One row of a List: title, a muted description, meta on the right (a Badge or a formatDate), then actions (Buttons, usually ghost or secondary). Give it key when mapping.',
  ProgressBar: 'ProgressBar({ label: string, value: number, max?: number, tone?: Tone, showValue?: boolean }). A labelled bar for value out of max (default 100), shown as a percentage. For completion, or progress toward a goal.',
  BarChart: 'BarChart({ label: string, data: { label: string, value: number }[], max?: number, tone?: Tone, valueSuffix?: string }). Horizontal bars with each value printed: answers per option, attendance by week. Up to about 12 bars. valueSuffix like "%" or " pts". Shows "No data yet." when data is empty.',
  RosterTable: 'RosterTable({ label: string, students: string[], columns: { key: string, header: string }[], cells: (student: string) => Record<string, RosterCell>, onAction?: (student: string, column: string, value: string) => void, sort?: "name" | "given", searchable?: boolean, emptyText?: string }). Professor view only, with the course.roster capability. The class list WITH names: Scholera draws the names over it and the tool never sees them. students are handles from useRoster(). 0–4 columns. A cell is { kind: "text", text } | { kind: "badge", text, tone } | { kind: "choice", value: string | null, options: { value, label, tone }[] } (2–4 options, one click sets it) | { kind: "select", value: string | null, placeholder, options: { value, label }[] } | { kind: "button", label, value, variant: "primary" | "secondary" | "danger" }. A click calls onAction(student, columnKey, value). Search and name sorting happen inside Scholera (sort "given" keeps your order, for a queue). Example: <RosterTable label="Attendance" students={roster.students} columns={[{ key: "status", header: "Today" }]} cells={(s) => ({ status: { kind: "choice", value: marks.get(s)?.data.status ?? null, options: [{ value: "present", label: "Present", tone: "success" }, { value: "late", label: "Late", tone: "warning" }, { value: "absent", label: "Absent", tone: "danger" }] } })} onAction={(s, _column, value) => mark(s, value)} />',

  Button: 'Button({ onPress?: () => void, variant?: "primary" | "secondary" | "ghost" | "danger", disabled?: boolean, fullWidth?: boolean, children }). One primary button per screen or card, for its main action; secondary for the others; ghost for quiet actions in rows; danger for deleting. Always at least 44 px. No size, style or className: emphasis comes only from variant.',
  SegmentedControl: 'SegmentedControl({ label: string, value: string, options: { value: string, label: string }[], onChange: (value: string) => void }). Two to five exclusive choices, all visible: a filter ("All", "Open", "Answered") or a mode. label is for screen readers.',
  Tabs: 'Tabs({ label: string, value: string, onChange: (value: string) => void, tabs: { value: string, label: string, count?: number }[] }). Switches between parts of one screen. It draws only the tab row: render the selected part yourself, from value. count adds a small number.',
  TextField: 'TextField({ label: string, value: string, onChange: (value: string) => void, multiline?: boolean, placeholder?: string, hint?: string }). A labelled text input; multiline for paragraphs. Controlled: keep value in useState. hint is a muted helper line under it.',
  NumberField: 'NumberField({ label: string, value: number, onChange: (value: number) => void, min?: number, max?: number, step?: number }). A labelled number input. onChange fires only with a valid number inside min..max.',
  DateField: 'DateField({ label: string, value: string, onChange: (value: string) => void }). A date picker. value is "YYYY-MM-DD", or "" for none; start from today().',
  SearchField: 'SearchField({ label: string, value: string, onChange: (value: string) => void, placeholder?: string }). A search box. Filter your own list with it as the user types.',
  Select: 'Select({ label: string, value: string, options: { value: string, label: string }[], onChange: (value: string) => void, placeholder?: string }). A dropdown for one choice among many (more than five; fewer is a SegmentedControl). value "" shows the placeholder.',
  Checkbox: 'Checkbox({ label: string, checked: boolean, onChange: (checked: boolean) => void, description?: string }). A labelled checkbox, for ticking items off or agreeing.',
  Switch: 'Switch({ label: string, checked: boolean, onChange: (checked: boolean) => void, description?: string }). An on/off setting that applies at once: "Show answers after the deadline".',

  Alert: 'Alert({ tone: Tone, title: string, children? }). A tinted message in the page: "info" for guidance, "success" after saving, "warning" before a step that matters, "danger" when a save failed. Short. A failed load is ErrorState, not an Alert.',
  Loading: 'Loading({ label?: string }). Shown while data loads. Every view must use it.',
  Empty: 'Empty({ title: string, description?: string, children? }). Shown when there is nothing yet. Say what will appear and, for a professor, put the first action in children. Every view must use it.',
  ErrorState: 'ErrorState({ onRetry?: () => void }). Shown when a load fails; pass the hook\'s retry. It has no message prop: errors are never shown raw. Every view must use it.',

  request: 'request<T>(method, args?): Promise<T>. One raw Bridge call. For collections use useRecords instead. Always handle rejection (.catch), or the tool reports a crash. The method must be declared for this view by the manifest.',
  useRequest: 'useRequest<T>(method, args?): { status: "loading" | "ready" | "error", data?: T, retry: () => void }. A Bridge read that isn\'t a collection, as UI state. course.assignments returns { assignments: { title: string, dueAt: string | null, points: number | null }[] }; context.get returns { view, readOnly, course: { code, title }, can, skills }.',
  useRecords: 'useRecords<D>(collection: string): { status: "loading" | "ready" | "error", records: PluginRecord<D>[], retry, create(data: D, student?: string), update(record, data: D), remove(record), saveMany(changes) }. The way to read and write a collection: it loads every record (up to 1000) and keeps the list current after each write. Writes resolve to true when saved and false otherwise, and never throw: show an Alert on false. A record is { id, data, mine, student?, createdAt, updatedAt }. On a staffPerStudent collection, create(data, studentHandle) records something about one student and record.student is that handle. saveMany([{ op: "create", data, student? } | { op: "update", record, data } | { op: "delete", record }]) saves many at once, like "Mark everyone present". Example: const notes = useRecords<{ text: string }>("notes"); if (notes.status === "loading") return <Screen title="Notes"><Loading /></Screen>',
  useRoster: 'useRoster(): { status: "loading" | "ready" | "error", students: string[], retry }. The class as opaque handles ("st_…"), in no particular order. Professor view only, with the course.roster capability. Names never reach the tool: show students through RosterTable, and match records to students by record.student.',
  today: 'today(): string. Today as "YYYY-MM-DD" in the viewer\'s time zone. A natural key for daily records (attendance, check-ins).',
  formatDate: 'formatDate(iso: string, style?: "short" | "long"): string. "Oct 3", or "Friday, October 3, 2026". Takes "YYYY-MM-DD" or a timestamp like record.createdAt.',
}

const methods = BRIDGE_METHOD_NAMES.map((m) => JSON.stringify(m)).join(' | ')

/** The whole declaration world for plugin code. */
export const PLUGIN_ENV_DTS = `
// ── Language core (noLib: this is everything) ──
interface Object {}
interface Function { readonly length: number }
interface CallableFunction extends Function {}
interface NewableFunction extends Function {}
interface IArguments { readonly length: number; [index: number]: unknown }
interface Boolean {}
interface RegExp { test(s: string): boolean }
interface SymbolConstructor { readonly iterator: unique symbol }
declare var Symbol: SymbolConstructor
interface IteratorResult<T> { done?: boolean; value: T }
interface Iterator<T> { next(): IteratorResult<T> }
interface Iterable<T> { [Symbol.iterator](): Iterator<T> }
interface IterableIterator<T> extends Iterator<T> { [Symbol.iterator](): IterableIterator<T> }
interface TemplateStringsArray extends ReadonlyArray<string> { readonly raw: readonly string[] }

interface Number { toFixed(digits?: number): string; toString(): string }
interface NumberConstructor { (value?: unknown): number; isFinite(n: unknown): boolean; isInteger(n: unknown): boolean; readonly MAX_SAFE_INTEGER: number }
declare var Number: NumberConstructor
interface String {
  readonly length: number
  [index: number]: string
  charAt(i: number): string
  includes(s: string): boolean
  indexOf(s: string): number
  startsWith(s: string): boolean
  endsWith(s: string): boolean
  slice(start?: number, end?: number): string
  split(separator: string): string[]
  replace(search: string, replacement: string): string
  replaceAll(search: string, replacement: string): string
  trim(): string
  toLowerCase(): string
  toUpperCase(): string
  padStart(length: number, fill?: string): string
  repeat(count: number): string
  localeCompare(other: string): number
  [Symbol.iterator](): IterableIterator<string>
}
interface StringConstructor { (value?: unknown): string }
declare var String: StringConstructor
interface BooleanConstructor { (value?: unknown): boolean }
declare var Boolean: BooleanConstructor

interface ReadonlyArray<T> {
  readonly length: number
  readonly [n: number]: T
  map<U>(f: (value: T, index: number) => U): U[]
  filter<S extends T>(f: (value: T, index: number) => value is S): S[]
  filter(f: (value: T, index: number) => unknown): T[]
  find(f: (value: T, index: number) => unknown): T | undefined
  findIndex(f: (value: T, index: number) => unknown): number
  some(f: (value: T, index: number) => unknown): boolean
  every(f: (value: T, index: number) => unknown): boolean
  forEach(f: (value: T, index: number) => void): void
  reduce<U>(f: (acc: U, value: T, index: number) => U, initial: U): U
  includes(value: T): boolean
  indexOf(value: T): number
  join(separator?: string): string
  slice(start?: number, end?: number): T[]
  concat(...items: (T | readonly T[])[]): T[]
  flatMap<U>(f: (value: T, index: number) => U | readonly U[]): U[]
  at(index: number): T | undefined
  [Symbol.iterator](): IterableIterator<T>
}
interface Array<T> extends ReadonlyArray<T> {
  [n: number]: T
  length: number
  push(...items: T[]): number
  sort(compare?: (a: T, b: T) => number): this
  reverse(): this
  [Symbol.iterator](): IterableIterator<T>
}
interface ArrayConstructor { isArray(value: unknown): value is unknown[]; from<T>(items: Iterable<T> | ArrayLike<T>): T[] }
interface ArrayLike<T> { readonly length: number; readonly [n: number]: T }
declare var Array: ArrayConstructor

interface ObjectConstructor {
  keys(o: object): string[]
  values<T>(o: { [key: string]: T }): T[]
  entries<T>(o: { [key: string]: T }): [string, T][]
  fromEntries<T>(entries: Iterable<readonly [string, T]>): { [key: string]: T }
  assign<T extends object, U>(target: T, source: U): T & U
}
declare var Object: ObjectConstructor

interface Math { round(x: number): number; floor(x: number): number; ceil(x: number): number; min(...v: number[]): number; max(...v: number[]): number; abs(x: number): number; random(): number }
declare var Math: Math
interface JSON { stringify(value: unknown): string; parse(text: string): unknown }
declare var JSON: JSON
interface Date { getTime(): number; toISOString(): string; toLocaleDateString(locale?: string): string; toLocaleTimeString(locale?: string): string }
interface DateConstructor { new (value?: number | string): Date; now(): number }
declare var Date: DateConstructor
interface Error { name: string; message: string }
interface ErrorConstructor { new (message?: string): Error }
declare var Error: ErrorConstructor
interface Map<K, V> {
  get(key: K): V | undefined; set(key: K, value: V): this; has(key: K): boolean; delete(key: K): boolean; clear(): void; readonly size: number
  forEach(f: (value: V, key: K) => void): void
  keys(): IterableIterator<K>; values(): IterableIterator<V>; entries(): IterableIterator<[K, V]>; [Symbol.iterator](): IterableIterator<[K, V]>
}
interface MapConstructor { new <K, V>(entries?: Iterable<readonly [K, V]>): Map<K, V> }
declare var Map: MapConstructor
interface Set<T> {
  add(value: T): this; has(value: T): boolean; delete(value: T): boolean; clear(): void; readonly size: number
  forEach(f: (value: T) => void): void
  values(): IterableIterator<T>; [Symbol.iterator](): IterableIterator<T>
}
interface SetConstructor { new <T>(values?: Iterable<T>): Set<T> }
declare var Set: SetConstructor

interface PromiseLike<T> { then<R1 = T, R2 = never>(ok?: ((v: T) => R1 | PromiseLike<R1>) | null, fail?: ((e: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> }
interface Promise<T> {
  then<R1 = T, R2 = never>(ok?: ((v: T) => R1 | PromiseLike<R1>) | null, fail?: ((e: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2>
  catch<R = never>(fail?: ((e: unknown) => R | PromiseLike<R>) | null): Promise<T | R>
  finally(f?: (() => void) | null): Promise<T>
}
interface PromiseConstructor { new <T>(executor: (resolve: (v: T) => void, reject: (e?: unknown) => void) => void): Promise<T>; resolve<T>(v: T): Promise<T>; all<T>(values: readonly (T | PromiseLike<T>)[]): Promise<T[]> }
declare var Promise: PromiseConstructor
type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T

declare function parseInt(s: string, radix?: number): number
declare function parseFloat(s: string): number
declare function isNaN(n: number): boolean
declare function setTimeout(callback: () => void, ms?: number): number
declare function clearTimeout(id?: number): void
declare function setInterval(callback: () => void, ms?: number): number
declare function clearInterval(id?: number): void

type Partial<T> = { [P in keyof T]?: T[P] }
type Required<T> = { [P in keyof T]-?: T[P] }
type Readonly<T> = { readonly [P in keyof T]: T[P] }
type Pick<T, K extends keyof T> = { [P in K]: T[P] }
type Record<K extends keyof any, T> = { [P in K]: T }
type Exclude<T, U> = T extends U ? never : T
type Extract<T, U> = T extends U ? T : never
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>
type NonNullable<T> = T & {}
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any

// ── What a view renders ──
declare const kitElementBrand: unique symbol
interface KitElement { readonly [kitElementBrand]: true }
type KitNode = KitElement | string | number | boolean | null | undefined | readonly KitNode[]

declare namespace JSX {
  type Element = KitElement
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number }
  // Empty on purpose: a view has no raw HTML elements, only kit components.
  interface IntrinsicElements {}
}

declare module 'react' {
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]
  export function useState<S = undefined>(): [S | undefined, (next: S | undefined | ((prev: S | undefined) => S | undefined)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T
  export function useRef<T>(initial: T): { current: T }
  export function Fragment(props: { children?: KitNode }): KitElement
}

declare module '@scholera/plugin-kit' {
  export type BridgeMethod = ${methods}
  export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  /** student: the handle of the student a record is about, for staff viewers of a perStudent or staffPerStudent collection. */
  export interface PluginRecord<D = Record<string, unknown>> { id: string; data: D; mine: boolean; student?: string; createdAt: string; updatedAt: string }
  export interface PluginContext {
    view: 'student' | 'professor'
    readOnly: boolean
    course: { code: string; title: string }
    can: Record<string, { read: boolean; write: boolean }>
    skills?: Record<string, string | null>
  }
  export interface RequestState<T> { status: 'loading' | 'ready' | 'error'; data?: T; retry: () => void }
  export type RecordChange<D> =
    | { op: 'create'; data: D; student?: string }
    | { op: 'update'; record: PluginRecord<D>; data: D }
    | { op: 'delete'; record: PluginRecord<D> }
  export interface RecordsState<D> {
    status: 'loading' | 'ready' | 'error'
    records: PluginRecord<D>[]
    retry: () => void
    create: (data: D, student?: string) => Promise<boolean>
    update: (record: PluginRecord<D>, data: D) => Promise<boolean>
    remove: (record: PluginRecord<D>) => Promise<boolean>
    saveMany: (changes: readonly RecordChange<D>[]) => Promise<boolean>
  }
  export interface RosterState { status: 'loading' | 'ready' | 'error'; students: string[]; retry: () => void }
  export type RosterCell =
    | { kind: 'text'; text: string }
    | { kind: 'badge'; text: string; tone: Tone }
    | { kind: 'choice'; value: string | null; options: readonly { value: string; label: string; tone: Tone }[] }
    | { kind: 'select'; value: string | null; placeholder: string; options: readonly { value: string; label: string }[] }
    | { kind: 'button'; label: string; value: string; variant: 'primary' | 'secondary' | 'danger' }

  export function request<T = unknown>(method: BridgeMethod, args?: object): Promise<T>
  export function useRequest<T = unknown>(method: BridgeMethod, args?: object): RequestState<T>
  export function useRecords<D = Record<string, unknown>>(collection: string): RecordsState<D>
  export function useRoster(): RosterState
  export function today(): string
  export function formatDate(iso: string, style?: 'short' | 'long'): string

  type Children = { children?: KitNode }
  type Header = { title?: string; description?: string; actions?: KitNode }
  type Gap = 'xsmall' | 'small' | 'medium' | 'large'
  type Option = { value: string; label: string }

  export function Screen(props: Header & { width?: 'normal' | 'wide' } & Children): KitElement
  export function Section(props: Header & Children): KitElement
  export function Card(props: Header & { tone?: Tone } & Children): KitElement
  export function Stack(props: { direction?: 'row' | 'column'; gap?: Gap; align?: 'start' | 'center' | 'end' | 'stretch'; justify?: 'start' | 'between' | 'end'; wrap?: boolean } & Children): KitElement
  export function Grid(props: { columns: 1 | 2 | 3 | 4; gap?: Gap } & Children): KitElement
  export function Divider(props: {}): KitElement
  export function Heading(props: { level?: 2 | 3 } & Children): KitElement
  export function Text(props: { tone?: 'default' | 'muted' | 'success' | 'warning' | 'danger'; size?: 'small' | 'medium' | 'large'; weight?: 'regular' | 'medium' | 'bold' } & Children): KitElement

  export function Badge(props: { tone?: Tone } & Children): KitElement
  export function StatCard(props: { label: string; value: string | number; hint?: string; tone?: Tone }): KitElement
  export function DataTable(props: {
    label: string
    columns: readonly { key: string; header: string; align?: 'start' | 'center' | 'end' }[]
    rows: readonly { key: string; cells: Record<string, KitNode> }[]
    emptyText?: string
  }): KitElement
  export function List(props: { label?: string } & Children): KitElement
  export function ListItem(props: { title: string; description?: string; meta?: KitNode; actions?: KitNode }): KitElement
  export function ProgressBar(props: { label: string; value: number; max?: number; tone?: Tone; showValue?: boolean }): KitElement
  export function BarChart(props: { label: string; data: readonly { label: string; value: number }[]; max?: number; tone?: Tone; valueSuffix?: string }): KitElement
  export function RosterTable(props: {
    label: string
    students: readonly string[]
    columns: readonly { key: string; header: string }[]
    cells: (student: string) => Record<string, RosterCell>
    onAction?: (student: string, column: string, value: string) => void
    sort?: 'name' | 'given'
    searchable?: boolean
    emptyText?: string
  }): KitElement

  export function Button(props: { onPress?: () => void; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; disabled?: boolean; fullWidth?: boolean } & Children): KitElement
  export function SegmentedControl(props: { label: string; value: string; options: readonly Option[]; onChange: (value: string) => void }): KitElement
  export function Tabs(props: { label: string; value: string; onChange: (value: string) => void; tabs: readonly { value: string; label: string; count?: number }[] }): KitElement
  export function TextField(props: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; placeholder?: string; hint?: string }): KitElement
  export function NumberField(props: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }): KitElement
  export function DateField(props: { label: string; value: string; onChange: (value: string) => void }): KitElement
  export function SearchField(props: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }): KitElement
  export function Select(props: { label: string; value: string; options: readonly Option[]; onChange: (value: string) => void; placeholder?: string }): KitElement
  export function Checkbox(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; description?: string }): KitElement
  export function Switch(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; description?: string }): KitElement

  export function Alert(props: { tone: Tone; title: string } & Children): KitElement
  export function Loading(props: { label?: string }): KitElement
  export function Empty(props: { title: string; description?: string } & Children): KitElement
  export function ErrorState(props: { onRetry?: () => void }): KitElement
}
`
