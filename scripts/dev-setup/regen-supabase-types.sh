#!/usr/bin/env bash
#
# Regenerate src/lib/supabase/types.ts from PRODUCTION, keeping the hand-written
# tail the generator does not emit.
#
# WHY THIS SCRIPT EXISTS
#
# The file is two things stitched together. Everything up to and including the
# `Constants` block is generated. Everything after it — currently 63 lines of
# `TableRow<'...'>` aliases like `export type Profile = ...` — was written by
# hand and the generator knows nothing about it. A plain overwrite silently
# deletes all of them, and the failure looks like hundreds of unrelated type
# errors rather than "you lost the aliases".
#
# It also refuses to write a file that DROPPED a table, which is the shape a
# mistake takes here: regenerating before your migration reached prod, or
# pointing at the wrong project.
#
# ORDER MATTERS: the generator reads prod, so the migration must be applied
# there FIRST or the new tables simply will not be in the output.
#
# Usage:  bash scripts/dev-setup/regen-supabase-types.sh <project-ref>
# Prod ref: ywdqaoahfmmzcsczxvxn

set -euo pipefail

REF="${1:-}"
if [ -z "$REF" ]; then
  echo "usage: $0 <supabase-project-ref>" >&2
  exit 1
fi

TYPES="src/lib/supabase/types.ts"
MARKER="} as const"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ ! -f "$TYPES" ]; then
  echo "error: $TYPES not found — run this from the repo root" >&2
  exit 1
fi

# 1. Split the current file at the end of the generated section.
CUT="$(grep -n "^${MARKER}\$" "$TYPES" | head -1 | cut -d: -f1)"
if [ -z "$CUT" ]; then
  echo "error: could not find the '${MARKER}' marker that ends the generated section." >&2
  echo "       The file's shape changed; splice by hand and update this script." >&2
  exit 1
fi
tail -n "+$((CUT + 1))" "$TYPES" > "$TMP/tail.ts"
echo "kept $(wc -l < "$TMP/tail.ts" | tr -d ' ') hand-written lines after line $CUT"

# 2. Generate fresh types from prod.
echo "generating from project $REF ..."
npx supabase gen types typescript --project-id "$REF" --schema public > "$TMP/generated.ts"

if [ ! -s "$TMP/generated.ts" ]; then
  echo "error: generator produced an empty file — not overwriting anything." >&2
  exit 1
fi

# 3. Refuse to lose a table. A regenerate should ADD tables, never remove them;
#    if one disappeared, you are pointed at the wrong project or the migration
#    has not landed yet.
# Table names sit at exactly six spaces of indent inside the `Tables: {` block,
# which ends at the sibling `Views: {`. Both anchors are indented four spaces —
# getting that wrong silently yields zero tables and makes the safety check
# below vacuous, so the caller asserts a non-empty result.
tables() {
  sed -n '/^    Tables: {/,/^    Views: {/p' "$1" \
    | grep -E '^      [a-z_]+: \{' | sed 's/[ :{]//g' | sort
}
tables "$TYPES" > "$TMP/before.txt"
tables "$TMP/generated.ts" > "$TMP/after.txt"

# A check that cannot see any tables is not a check. Fail loudly rather than
# reporting "no table changes" because the parser matched nothing.
if [ ! -s "$TMP/before.txt" ] || [ ! -s "$TMP/after.txt" ]; then
  echo "error: could not parse table names from one of the files." >&2
  echo "       The generated shape changed; fix tables() before trusting this." >&2
  exit 1
fi
echo "tables before: $(wc -l < "$TMP/before.txt" | tr -d ' '), after: $(wc -l < "$TMP/after.txt" | tr -d ' ')"

LOST="$(comm -23 "$TMP/before.txt" "$TMP/after.txt")"
GAINED="$(comm -13 "$TMP/before.txt" "$TMP/after.txt")"

if [ -n "$GAINED" ]; then
  echo "new tables:"
  echo "$GAINED" | sed 's/^/  + /'
fi
if [ -n "$LOST" ]; then
  echo >&2
  echo "REFUSING TO WRITE — these tables vanished from the generated output:" >&2
  echo "$LOST" | sed 's/^/  - /' >&2
  echo >&2
  echo "That usually means the wrong project ref, or a migration that has not" >&2
  echo "reached prod yet. Nothing was changed." >&2
  exit 1
fi
if [ -z "$GAINED" ]; then
  echo "no table changes (this is fine if you only changed columns or functions)"
fi

# 4. Stitch and write.
cat "$TMP/generated.ts" "$TMP/tail.ts" > "$TYPES"
echo "wrote $TYPES ($(wc -l < "$TYPES" | tr -d ' ') lines)"

echo
echo "next:"
echo "  1. add an alias for any new table at the bottom of $TYPES, e.g."
echo "       export type InstitutionFeatureRequest = TableRow<'institution_feature_requests'>"
echo "  2. npm run typecheck"
echo "  3. git diff $TYPES   # confirm the tail survived and nothing else moved"
