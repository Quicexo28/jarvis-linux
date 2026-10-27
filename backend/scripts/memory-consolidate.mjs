#!/usr/bin/env node
/**
 * One-off clean-up of the long-term memory (facts table) with the same rules
 * learnFromTurn now applies to new facts:
 *   - identity confusion: facts saying the señor is called Jarvis;
 *   - near-duplicates: the same fact in other words — the one with more hits
 *     (then the older one) stays, its variants go.
 *
 *   node scripts/memory-consolidate.mjs           # DRY RUN: prints the plan
 *   node scripts/memory-consolidate.mjs --apply   # deletes what the plan lists
 *
 * Run it with the backend stopped or idle; it writes backend/data/jarvis.db.
 */
import { allFacts, deleteFact } from '../src/lib/turnStore.js'
import { isIdentityConfusion, findNearDuplicate } from '../src/lib/memory.js'

const apply = process.argv.includes('--apply')
const facts = allFacts(5000).sort((a, b) => (b.hits - a.hits) || (a.id - b.id))
const kept = []
const drop = []

for (const f of facts) {
  if (isIdentityConfusion(f.text)) { drop.push({ f, why: 'identidad: el señor no se llama Jarvis' }); continue }
  const dup = findNearDuplicate(f.text, kept)
  if (dup) { drop.push({ f, why: `duplica #${dup.id} «${dup.text.slice(0, 60)}»` }); continue }
  kept.push(f)
}

console.log(`${facts.length} hechos · se quedan ${kept.length} · ${apply ? 'BORRANDO' : 'se borrarían'} ${drop.length}\n`)
for (const { f, why } of drop.sort((a, b) => a.f.id - b.f.id)) {
  console.log(`#${f.id} «${f.text.slice(0, 80)}» — ${why}`)
  if (apply) deleteFact(f.id)
}
if (!apply && drop.length) console.log('\nNada se borró. Para aplicar: node scripts/memory-consolidate.mjs --apply')
