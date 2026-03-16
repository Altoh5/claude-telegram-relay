#!/bin/bash
# Quick dual-mode health check: compare Supabase vs Convex row counts
# Run: bash scripts/verify-dual.sh

source .env 2>/dev/null

SUPA_KEY="${SUPABASE_SERVICE_ROLE_KEY:-$SUPABASE_ANON_KEY}"

echo "=== Dual-Write Verification ==="
echo ""

for table in messages memory logs twinmind_meetings; do
  supa_count=$(curl -s "${SUPABASE_URL}/rest/v1/${table}?select=id&limit=0" \
    -H "apikey: ${SUPA_KEY}" \
    -H "Authorization: Bearer ${SUPA_KEY}" \
    -H "Prefer: count=exact" \
    -I 2>/dev/null | grep -i content-range | sed 's/.*\///')
  echo "  ${table}: Supabase=${supa_count:-?}"
done

echo ""
echo "Check Convex counts at: https://dashboard.convex.dev"
echo "If Supabase counts are growing, both writes are landing."
echo "If the bot responds with context, Convex reads are working."
