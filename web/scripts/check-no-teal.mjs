// Guard (spec 17.01, AC-1.1): the OPUS accent is a single blue. The old teal
// design system is gone, so no source file may hardcode a teal literal again.
// Scans web/src for the retired teal hexes and any Tailwind `teal-*` class.
// Exit 1 (and, as a Vitest test, fail) if any turns up. Tokens are the only
// source of color; this keeps the blue-accent decision enforced, not aspirational.
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, extname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, "..", "src")

// Retired teal brand + status hexes from the old design system, and the
// Tailwind `teal-<shade>` utilities. Case-insensitive.
const TEAL_HEX = [
  "#0d9488",
  "#2dd4bf",
  "#14b8a6",
  "#0b7a70",
  "#5eead4",
  "#e2f4f1",
  "#16302e",
  "#04201c",
]
const PATTERNS = [
  ...TEAL_HEX.map((h) => ({ label: h, re: new RegExp(h, "i") })),
  { label: "teal-<shade> utility", re: /\bteal-\d{2,3}\b/ },
]

const SCAN_EXT = new Set([".ts", ".tsx", ".css", ".js", ".jsx", ".mjs"])

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (SCAN_EXT.has(extname(entry.name))) {
      yield full
    }
  }
}

/** Returns an array of { file, line, label } for every teal literal found. */
export async function findTealLiterals() {
  const hits = []
  for await (const file of walk(SRC)) {
    const text = await readFile(file, "utf8")
    text.split(/\r?\n/).forEach((line, i) => {
      for (const { label, re } of PATTERNS) {
        if (re.test(line)) {
          hits.push({ file, line: i + 1, label, text: line.trim() })
        }
      }
    })
  }
  return hits
}

// CLI entry: `node scripts/check-no-teal.mjs`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-no-teal.mjs")) {
  const hits = await findTealLiterals()
  if (hits.length > 0) {
    console.error(`✗ Found ${hits.length} teal literal(s) — use the blue accent tokens instead:\n`)
    for (const h of hits) {
      console.error(`  ${h.file}:${h.line}  [${h.label}]  ${h.text}`)
    }
    process.exit(1)
  }
  console.log("✓ No teal literals found.")
}
