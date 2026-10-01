// Test stub for Next.js's `server-only` package. In the app it throws if a
// server-only module is pulled into a client bundle; under Vitest there is no
// such bundle, so it's a harmless no-op. Aliased in vitest.config.ts so any
// server-only module can be imported by tests that exercise its real logic.
export {}
