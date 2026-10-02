/**
 * The plugin environment as the builder's typecheck sees it: hand-written, trusted
 * declarations for the two modules a plugin may import and the few globals it may use.
 *
 * The typecheck runs with `noLib`, so these declarations are the entire world. There is
 * no DOM, no `window`, no `fetch`, no Node and nothing of Scholera's: code that reaches
 * for any of them fails to typecheck. That is developer feedback, not the security
 * boundary. The sandbox, its security policy, the Bridge and the server still are.
 *
 * Every importable name is a member of the frozen `ScholeraKit` global that vendor.js
 * defines (vendor-entry.tsx). A test pins the two lists together, and another pins the
 * Bridge method names to the catalog.
 *
 * Pure and import-free on purpose: the check worker bundles it.
 */

/** What a view may import, by module. Each name binds to `ScholeraKit[name]`. */
export const KIT_IMPORTS = {
  react: ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'Fragment'],
  '@scholera/plugin-kit': [
    'Screen', 'Stack', 'Card', 'Heading', 'Text', 'Button', 'TextField', 'Checkbox',
    'Loading', 'Empty', 'ErrorState', 'request', 'useRequest',
  ],
} as const satisfies Record<string, readonly string[]>

/** Types the kit declares. Importing one binds nothing at run time. */
export const KIT_TYPE_NAMES = ['PluginRecord', 'PluginContext', 'RequestState', 'BridgeMethod'] as const

export type KitModule = keyof typeof KIT_IMPORTS
export type KitImportName = (typeof KIT_IMPORTS)[KitModule][number]
export const KIT_IMPORTABLE_NAMES = [...KIT_IMPORTS.react, ...KIT_IMPORTS['@scholera/plugin-kit']] as [KitImportName, ...KitImportName[]]

/** The Bridge methods a view may name. Kept equal to METHOD_CATALOG by a test. */
export const BRIDGE_METHOD_NAMES = [
  'context.get', 'course.skills', 'records.list', 'records.get', 'records.create', 'records.update', 'records.delete',
  'ui.resize', 'ui.toast',
] as const

/** What `get_kit_reference` returns for each name: props, then how to use it well. */
export const KIT_REFERENCE: Record<KitImportName, string> = {
  useState: 'useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]. React state. Import from "react".',
  useEffect: 'useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void. Import from "react". Fetch data with useRequest instead of an effect.',
  useMemo: 'useMemo<T>(factory: () => T, deps: readonly unknown[]): T. Import from "react".',
  useCallback: 'useCallback<T>(fn: T, deps: readonly unknown[]): T. Import from "react".',
  useRef: 'useRef<T>(initial: T): { current: T }. Import from "react". There are no DOM nodes to reference.',
  Fragment: 'Fragment: groups children without a wrapper. Import from "react", or write <>...</>.',
  Screen: 'Screen({ title?: string, children }). The root of every view. Exactly one per view, at the top.',
  Stack: 'Stack({ direction?: "row" | "column", gap?: "small" | "medium" | "large", children }). Lays children out in a row or column. Default column, medium gap.',
  Card: 'Card({ children }). A bordered section for one item.',
  Heading: 'Heading({ level?: 2 | 3, children }). A section heading. Screen already shows the page title.',
  Text: 'Text({ tone?: "default" | "muted", children }). A paragraph of plain text.',
  Button: 'Button({ onPress?: () => void, variant?: "primary" | "secondary", disabled?: boolean, children }). Default variant is primary. There is no size, style or className prop: every button is at least 44 px tall, and emphasis comes only from variant.',
  TextField: 'TextField({ label: string, value: string, onChange: (value: string) => void, multiline?: boolean, placeholder?: string }). A labelled text input. Controlled: keep the value in useState.',
  Checkbox: 'Checkbox({ label: string, checked: boolean, onChange: (checked: boolean) => void }). A labelled checkbox.',
  Loading: 'Loading({ label?: string }). Shown while data loads. Every view must use it.',
  Empty: 'Empty({ title: string, description?: string, children? }). Shown when there is nothing yet. Every view must use it.',
  ErrorState: 'ErrorState({ onRetry?: () => void }). Shown when a request fails. It has no message prop: errors are never shown raw. Every view must use it.',
  request: 'request<T>(method, args?): Promise<T>. One Bridge call, for writes: request("records.create", { collection, data }), request("records.update", { collection, recordId, data }), request("records.delete", { collection, recordId }). The method must be declared for this view by the manifest (capabilities, or a collection for records.*).',
  useRequest: 'useRequest<T>(method, args?): { status: "loading" | "ready" | "error", data?: T, retry: () => void }. A Bridge read as UI state: useRequest<PluginRecord<Card>[]>("records.list", { collection: "cards" }). Render Loading while loading, ErrorState on error, Empty when the list is empty. Call retry after a write to reload. records.list returns PluginRecord<D>[] with { id, data, mine, createdAt, updatedAt }. context.get returns { view, readOnly, course: { code, title }, can, skills }.',
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
interface Map<K, V> { get(key: K): V | undefined; set(key: K, value: V): this; has(key: K): boolean; delete(key: K): boolean; readonly size: number; forEach(f: (value: V, key: K) => void): void }
interface MapConstructor { new <K, V>(entries?: readonly (readonly [K, V])[]): Map<K, V> }
declare var Map: MapConstructor
interface Set<T> { add(value: T): this; has(value: T): boolean; delete(value: T): boolean; readonly size: number; forEach(f: (value: T) => void): void }
interface SetConstructor { new <T>(values?: readonly T[]): Set<T> }
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
  export interface PluginRecord<D = Record<string, unknown>> { id: string; data: D; mine: boolean; createdAt: string; updatedAt: string }
  export interface PluginContext {
    view: 'student' | 'professor'
    readOnly: boolean
    course: { code: string; title: string }
    can: Record<string, { read: boolean; write: boolean }>
    skills?: Record<string, string | null>
  }
  export interface RequestState<T> { status: 'loading' | 'ready' | 'error'; data?: T; retry: () => void }
  export function request<T = unknown>(method: BridgeMethod, args?: object): Promise<T>
  export function useRequest<T = unknown>(method: BridgeMethod, args?: object): RequestState<T>

  type Children = { children?: KitNode }
  export function Screen(props: { title?: string } & Children): KitElement
  export function Stack(props: { direction?: 'row' | 'column'; gap?: 'small' | 'medium' | 'large' } & Children): KitElement
  export function Card(props: Children): KitElement
  export function Heading(props: { level?: 2 | 3 } & Children): KitElement
  export function Text(props: { tone?: 'default' | 'muted' } & Children): KitElement
  export function Button(props: { onPress?: () => void; variant?: 'primary' | 'secondary'; disabled?: boolean } & Children): KitElement
  export function TextField(props: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; placeholder?: string }): KitElement
  export function Checkbox(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }): KitElement
  export function Loading(props: { label?: string }): KitElement
  export function Empty(props: { title: string; description?: string } & Children): KitElement
  export function ErrorState(props: { onRetry?: () => void }): KitElement
}
`
