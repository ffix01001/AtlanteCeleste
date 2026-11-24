// Strumento di sviluppo: trova le scritte italiane dell'interfaccia e le avvolge in t().
//   node tools/i18n_wrap.mjs src/ui/layers.ts            (mostra le proposte)
//   node tools/i18n_wrap.mjs --apply src/ui/layers.ts    (le applica)
// Le scritte con ${...} diventano t('... {nome} ...', { nome }).
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const files = args.filter((a) => !a.startsWith('--'));
const FN = process.env.ALIAS ?? 't';
const WORDS = new Set((process.env.WORDS ?? '').split(',').filter(Boolean));
const skipLines = new Set((process.env.SKIP ?? '').split(',').filter(Boolean).map(Number));

const EXCLUDE_PROPS = new Set(['class', 'className', 'style', 'type', 'role', 'id', 'href', 'target', 'rel', 'value', 'for', 'name',
  'src', 'key', 'kind', 'texture', 'color', 'background', 'font', 'cursor', 'display', 'slug', 'model', 'mode', 'tz', 'icon', 'inputmode', 'autocomplete']);
const CODE_WORDS = /^(auto|none|hidden|visible|block|flex|grid|inline|input|change|click|keydown|keyup|pointerdown|pointerup|pointermove|wheel|resize|checkbox|range|button|select|option|label|span|div|canvas|true|false|left|right|top|bottom|center|middle|bold|normal|smooth|instant|anonymous|srgb|linear|nearest|high|low|default|module|json|text|blob|number|string|object|function|undefined|dialog|status|polite|assertive|noopener|_blank|utf-8|abort|error|load|message|scroll|focus|blur|contextmenu|dblclick|mouseenter|mouseleave|transitionend|visibilitychange|beforeunload|fullscreenchange|en-US|it-IT|UTC|planet|moon|dwarf|comet|asteroid|star|spacecraft|satellite|nebula|galaxy|cluster|barycenter|region|exoplanet|fill|stroke|evenodd|butt|round|square|miter|bevel|alphabetic|ideographic|hanging|start|end|ltr|rtl)$/;

function italianish(s) {
  const t = s.trim();
  if (t.length < 2) return false;
  if (WORDS.has(t)) return true;
  if (/^[a-z]+:\S+$/.test(t)) return false;                                                 // identificativi (naif:399, sb:1P)
  if (/^[a-z]{2}-[A-Z]{2}$/.test(t) || /^[a-z]+[A-Z]\w*$/.test(t)) return false;           // locale, camelCase
  if (/\d+px|sans-serif|monospace/.test(t)) return false;                                   // caratteri tipografici
  if (/[;{}]/.test(t) && /\n|void |uniform |gl_|vec\d/.test(t)) return false;                // GLSL
  if (/^(translate|rotate|scale|matrix|calc|perspective)\w*\(/.test(t)) return false;          // CSS
  if (!/\s/.test(t) && /[/|_]/.test(t)) return false;
  if (/^(Atlante Celeste|Wikipedia|Starlink|EffectComposer\.\w+)$/.test(t)) return false;
  if (/^[a-z][\w-]* [a-z][\w-]*-\{?/.test(t) || /^[a-z]+-[a-z]+( |$)/.test(t)) return false;   // classi CSS
  if (!/[A-Za-zÀ-ÿ]{2,}/.test(t)) return false;
  if (/^(https?:|\/|\.\.?\/|#|rgba?\(|hsla?\(|var\(|url\(|data:|@|\$\{)/.test(t)) return false;
  if (/^[a-z0-9_:.\-/]+$/.test(t)) return CODE_WORDS.test(t) ? false : /[àèéìòù]/.test(t) ? true : 'single';
  if (/^[a-z-]+(\s+[a-z-]+)*$/.test(t) && /(^|\s)(btn|panel|toggle|swatch|muted|small|sub|row|col|hud|card|label|link|icon|is-|has-)/.test(t)) return false;
  if (/^[A-Z][A-Za-z0-9]*$/.test(t) && /[A-Z].*[A-Z]/.test(t)) return false;   // CamelCase o sigle
  if (/^[A-Z0-9 _:./-]+$/.test(t)) return false;                                 // sigle: NASA, HST, ...
  return true;
}

function propName(node) {
  const p = node.parent;
  if (ts.isPropertyAssignment(p) && p.initializer === node) {
    const n = p.name;
    return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;
  }
  return null;
}

function skip(node) {
  const p = node.parent;
  if (!p) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;           // chiave di un oggetto
  if (ts.isPropertySignature(p) || ts.isEnumMember(p)) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword].includes(p.operatorToken.kind)) return true;
  if (ts.isCallExpression(p)) {
    const e = p.expression;
    const txt = e.getText();
    if (/^(t|tn|tr|console\.\w+|log\.\w+|require|import|fetch|getJson|postJson|getBinary|querySelector|querySelectorAll|getElementById|addEventListener|removeEventListener|setAttribute|getAttribute|createElement|startsWith|endsWith|includes|indexOf|split|replace|replaceAll|match|test|localeCompare|getItem|setItem|loadPref|savePref|normalize|toLocaleString|toLocaleDateString|toLocaleTimeString|DateTimeFormat|NumberFormat|has|get|set|delete)$/.test(txt.split('.').pop()) && !/^h$/.test(txt)) {
      if (/(^|\.)(console|log)\./.test(txt) || /^(t|tn|tr)$/.test(txt) || /(startsWith|endsWith|includes|indexOf|split|replace|replaceAll|match|test|delete|querySelector|querySelectorAll|getElementById|addEventListener|removeEventListener|setAttribute|getAttribute|createElement|getItem|setItem|loadPref|savePref|fetch|getJson|postJson|getBinary|DateTimeFormat|NumberFormat|toLocaleString|toLocaleDateString|toLocaleTimeString|localeCompare)$/.test(txt)) return true;
      if (/(^|\.)(set|has|get)$/.test(txt) && p.arguments[0] === node) return true;
    }
  }
  if (ts.isNewExpression(p) && /^(Error|RegExp|URL|Worker)$/.test(p.expression.getText())) return true;
  const pn = propName(node);
  if (pn && EXCLUDE_PROPS.has(pn)) return true;
  return false;
}

function phName(expr, used, i) {
  let n = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : `v${i}`;
  if (!/^\w+$/.test(n)) n = `v${i}`;
  let k = n, j = 2;
  while (used.has(k)) k = `${n}${j++}`;
  used.add(k);
  return k;
}

const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const edits = [];
  const singles = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const ok = italianish(node.text);
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (ok && !skip(node) && !skipLines.has(line)) {
        if (ok === 'single') singles.push([line, node.text]);
        else edits.push({ start: node.getStart(), end: node.getEnd(), text: `${FN}(${quote(node.text)})`, line, show: node.text });
      }
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (italianish(parts.replace(/\s+/g, ' ')) === true && !skip(node) && !skipLines.has(line)) {
        const used = new Set();
        let key = node.head.text;
        const params = [];
        node.templateSpans.forEach((sp, i) => {
          const name = phName(sp.expression, used, i);
          key += `{${name}}` + sp.literal.text;
          const exprText = sp.expression.getText();
          params.push(name === exprText ? name : `${name}: ${exprText}`);
        });
        edits.push({ start: node.getStart(), end: node.getEnd(), text: `${FN}(${quote(key)}, { ${params.join(', ')} })`, line, show: key });
        return; // le espressioni interne restano come sono
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  console.log(`\n=== ${file}: ${edits.length} scritte` + (singles.length ? `, ${singles.length} parole singole da vedere` : ''));
  for (const e of edits) console.log(`${e.line}: ${e.show}`);
  for (const [l, s] of singles) console.log(`  ? ${l}: ${s}`);
  if (apply && edits.length) {
    let out = src;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    if (!new RegExp(`import \\{[^}]*\\b${FN}\\b[^}]*\\} from '[./]*/?(core/)?i18n'`).test(out)) {
      const rel = path.relative(path.dirname(file), 'src/core/i18n').replace(/\\/g, '/');
      const spec = rel.startsWith('.') ? rel : './' + rel;
      const m = out.match(/^import [^;]+;\n/m);
      const lead = out.match(/^(\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*/)[0];
      const at = m ? out.indexOf(m[0]) : lead.length;
      out = out.slice(0, at) + `import { ${FN === 't' ? 't' : `t as ${FN}`} } from '${spec}';\n` + out.slice(at);
    }
    fs.writeFileSync(file, out);
  }
}
