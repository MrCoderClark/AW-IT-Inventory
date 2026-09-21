// A no-op stand-in for marker packages like `server-only` under Vitest, so a
// module that imports them can load in the test environment. The real package
// exists only to fail a client bundle; in tests it should do nothing.
export {};
