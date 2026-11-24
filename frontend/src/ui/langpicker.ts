/** Scelta della lingua: un piccolo menu nella barra in alto. Cambiando lingua la pagina si ricarica. */

import { LANGS, lang, saveLang, type Lang } from '../core/i18n';
import { h } from './dom';

export function langPicker(): HTMLSelectElement {
  const sel = h('select', { class: 'lang-select', title: 'Lingua · Language', 'aria-label': 'Lingua · Language' },
    ...LANGS.map((l) => h('option', { value: l.code, selected: l.code === lang() }, l.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => {
    saveLang(sel.value as Lang);
    location.reload();
  });
  return sel;
}
