// Strumento di sviluppo: raccoglie tutte le scritte da tradurre e controlla i dizionari.
//   node tools/i18n_keys.mjs            elenco aggiornato in tools/i18n_chiavi.json + resoconto per lingua
//   node tools/i18n_keys.mjs --missing en   stampa le scritte che mancano in inglese (JSON)
// Le chiavi sono le scritte italiane passate a t('...'), tr('...') e tn(n, '...', '...'),
// più i nomi delle città e delle regioni di src/core/places.ts (tradotti con t(r[0])).
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'src');
const LANGS = ['en', 'es', 'de', 'fr'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []);
}

const keys = new Map();      // chiave -> { files:Set, plural?: one }
const add = (k, file, one) => {
  const e = keys.get(k) ?? { files: new Set() };
  e.files.add(path.relative(SRC, file));
  if (one !== undefined) e.one = one;
  keys.set(k, e);
};
const dynamic = [];

for (const file of walk(SRC)) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const fn = n.expression.text;
      const lit = (a) => a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : null;
      if (fn === 't' || fn === 'tr') {
        const k = lit(n.arguments[0]);
        if (k !== null) add(k, file);
        else if (!/^(places\.ts)$/.test(path.basename(file))) dynamic.push(`${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      } else if (fn === 'tn') {
        const one = lit(n.arguments[1]), other = lit(n.arguments[2]);
        if (other !== null) add(other, file, one ?? undefined);
      }
    }
    // tabelle delle città: [nome, lat, lon, regione, fuso]
    if (path.basename(file) === 'places.ts' && file.includes('/core/') && ts.isArrayLiteralExpression(n)
      && n.elements.length >= 3 && ts.isStringLiteral(n.elements[0]) && ts.isNumericLiteral(n.elements[1])) {
      add(n.elements[0].text, file);
      if (n.elements[3] && ts.isStringLiteral(n.elements[3])) add(n.elements[3].text, file);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b, 'it'));
const out = Object.fromEntries(sorted.map((k) => [k, { file: [...keys.get(k).files].join(', '), ...(keys.get(k).one !== undefined ? { one: keys.get(k).one } : {}) }]));
fs.writeFileSync(path.join(ROOT, 'tools', 'i18n_chiavi.json'), JSON.stringify(out, null, 1) + '\n');

const arg = process.argv.indexOf('--missing');
if (arg > 0) {
  const lang = process.argv[arg + 1];
  const dict = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n', `${lang}.json`), 'utf8'));
  const miss = Object.fromEntries(sorted.filter((k) => !(k in dict)).map((k) => [k, keys.get(k).one !== undefined ? { one: keys.get(k).one, other: k } : '']));
  console.log(JSON.stringify(miss, null, 1));
} else {
  console.log(`Scritte da tradurre: ${sorted.length} (plurali: ${sorted.filter((k) => keys.get(k).one !== undefined).length})`);
  for (const l of LANGS) {
    const dict = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n', `${l}.json`), 'utf8'));
    const have = sorted.filter((k) => k in dict).length;
    const stale = Object.keys(dict).filter((k) => !keys.has(k));
    console.log(`  ${l}: ${have} tradotte, ${sorted.length - have} mancanti${stale.length ? `, ${stale.length} non più usate` : ''}`);
  }
  if (dynamic.length) console.log(`Chiamate con chiave non letterale (controllare a mano): ${dynamic.length}\n  ${dynamic.join('\n  ')}`);
}
