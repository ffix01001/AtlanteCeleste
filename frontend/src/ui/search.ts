/** Ricerca per nome fra tutti i corpi: catalogo, asteroidi, comete, satelliti, stelle. */

import { t } from '../core/i18n';
import { normalize } from '../core/format';
import { ORBIT_CLASS_IT } from '../data/classes';
import { clear, h } from './dom';

export interface SearchItem {
  name: string;
  hint: string;
  norm: string;
  weight: number; // più basso = più importante
  pick: () => void;
}

export class SearchBox {
  readonly root: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLUListElement;
  private sources: (() => SearchItem[])[] = [];
  private cache: SearchItem[] | null = null;
  private results: SearchItem[] = [];
  /** nomi dei preferiti: si mostrano aprendo la ricerca senza scrivere nulla */
  favorites: () => string[] = () => [];
  private active = 0;

  constructor(parent: HTMLElement) {
    this.input = h('input', {
      type: 'search', class: 'search-input', placeholder: t('Cerca un corpo celeste, un satellite, una stella'),
      'aria-label': t('Cerca'), autocomplete: 'off', spellcheck: 'false',
    });
    this.list = h('ul', { class: 'search-results', role: 'listbox' });
    this.list.hidden = true;
    this.root = h('div', { class: 'search' }, this.input, h('kbd', { class: 'search-key', title: t('Scorciatoia') }, '/'), this.list);
    parent.appendChild(this.root);
    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('focus', () => this.run());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => setTimeout(() => (this.list.hidden = true), 150));
  }

  addSource(fn: () => SearchItem[]): void {
    this.sources.push(fn);
    this.cache = null;
  }

  invalidate(): void {
    this.cache = null;
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  private all(): SearchItem[] {
    if (!this.cache) this.cache = this.sources.flatMap((s) => s());
    return this.cache;
  }

  private run(): void {
    const q = normalize(this.input.value.trim());
    clear(this.list);
    if (!q) {
      // senza testo: i preferiti (se ce ne sono)
      const favs = this.favorites();
      if (!favs.length) {
        this.list.hidden = true;
        return;
      }
      const all = this.all();
      this.results = [];
      for (const name of favs) {
        let best: SearchItem | null = null;
        for (const it of all) if (it.name === name && (!best || it.weight < best.weight)) best = it;
        if (best) this.results.push(best);
      }
      this.active = 0;
      this.list.append(h('li', { class: 'empty' }, this.results.length ? t('Preferiti') : t('I preferiti compariranno qui appena i cataloghi sono caricati.')));
      this.results.forEach((it, idx) => {
        this.list.append(h('li', { role: 'option', class: idx === 0 ? 'active' : '', onmousedown: (e: Event) => { e.preventDefault(); this.choose(idx); } },
          h('span', { class: 'r-name' }, `★ ${it.name}`), h('span', { class: 'r-hint' }, it.hint)));
      });
      this.list.hidden = false;
      return;
    }
    const found: { it: SearchItem; score: number }[] = [];
    for (const it of this.all()) {
      const i = it.norm.indexOf(q);
      if (i < 0) continue;
      let score = it.weight;
      if (it.norm === q) score -= 100;
      else if (i === 0) score -= 50;
      else if (it.norm[i - 1] === ' ' || it.norm[i - 1] === '/' || it.norm[i - 1] === '(') score -= 30;
      score += it.norm.length * 0.05;
      found.push({ it, score });
      if (found.length > 4000) break;
    }
    found.sort((a, b) => a.score - b.score);
    this.results = found.slice(0, 12).map((f) => f.it);
    this.active = 0;
    if (!this.results.length) {
      this.list.append(h('li', { class: 'empty' }, t('Nessun risultato. Prova con il nome inglese o con il numero di catalogo.')));
    }
    this.results.forEach((it, idx) => {
      const li = h('li', { role: 'option', class: idx === 0 ? 'active' : '', onmousedown: (e: Event) => { e.preventDefault(); this.choose(idx); } },
        h('span', { class: 'r-name' }, it.name), h('span', { class: 'r-hint' }, it.hint));
      this.list.append(li);
    });
    this.list.hidden = false;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.results.length) return;
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.results.length) % this.results.length;
      [...this.list.children].forEach((li, i) => li.classList.toggle('active', i === this.active));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.choose(this.active);
    } else if (e.key === 'Escape') {
      this.input.value = '';
      this.list.hidden = true;
      this.input.blur();
    }
    e.stopPropagation();
  }

  private choose(i: number): void {
    const it = this.results[i];
    if (!it) return;
    this.list.hidden = true;
    this.input.value = '';
    this.input.blur();
    it.pick();
  }
}

export function classHint(code: string): string {
  return ORBIT_CLASS_IT[code] ?? t('Corpo minore');
}
