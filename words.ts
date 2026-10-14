// Which words signal free food? Mines the labelled messages table (every analysed email carries the model's
// verdict) and prints the most discriminative words/bigrams for free-food vs not. Run after the app has
// processed some mail:
//   DB_PATH=/data/freefood.db node words.ts
import { db } from './db.ts';
import { KEYWORDS } from './extract.ts';

interface Row { subject: string | null; snippet: string | null; matched: string | null; is_free_food: number | null }
const rows = db.prepare("select subject, snippet, matched, is_free_food from messages where matched != 'not-read'").all() as unknown as Row[];
const labelled = rows.filter(r => r.is_free_food !== null);
if (labelled.length < 10) { console.log(`only ${labelled.length} labelled messages; need ~10+`); process.exit(0); }

const STOP = new Set('the a an and or of to in on at for is are be will this that with from by we you your our it as if not do have has can all any more'.split(' '));
const grams = (t: string) => {
  const w = t.toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').split(/\s+/).filter(x => x.length > 2 && !STOP.has(x));
  return new Set([...w, ...w.slice(1).map((x, i) => `${w[i]} ${x}`)]);
};
const pos = new Map<string, number>(), neg = new Map<string, number>();
let np = 0, nn = 0;
for (const r of labelled) {
  const m = r.is_free_food ? (np++, pos) : (nn++, neg);
  for (const g of grams(`${r.subject} ${r.snippet}`)) m.set(g, (m.get(g) || 0) + 1);
}
const score = [...new Set([...pos.keys(), ...neg.keys()])]
  .map(g => ({ g, p: pos.get(g) || 0, n: neg.get(g) || 0 }))
  .filter(x => x.p + x.n >= 3)
  .map(x => ({ ...x, lo: Math.log((x.p + 0.5) / (np + 1)) - Math.log((x.n + 0.5) / (nn + 1)) }))
  .sort((a, b) => b.lo - a.lo);

console.log(`labelled: ${np} free-food, ${nn} not. Top free-food indicators (log-odds):`);
for (const x of score.slice(0, 40)) console.log(`${x.lo.toFixed(2).padStart(6)}  ${x.g.padEnd(24)} ${x.p}+ ${x.n}-  ${KEYWORDS.includes(x.g) ? '' : '<- not in KEYWORDS'}`);
console.log('\nStrongest NOT-free-food words:');
for (const x of score.slice(-15).reverse()) console.log(`${x.lo.toFixed(2).padStart(6)}  ${x.g.padEnd(24)} ${x.p}+ ${x.n}-`);

const top = new Set(score.slice(0, 20).map(x => x.g));
const suspicious = rows.filter(r => r.is_free_food === 0 && [...grams(`${r.subject} ${r.snippet}`)].some(g => top.has(g)));
console.log(`\n${suspicious.length} emails the model rejected although they contain a top indicator (spot-check these):`);
for (const r of suspicious.slice(0, 15)) console.log(`  - ${r.subject}`);
