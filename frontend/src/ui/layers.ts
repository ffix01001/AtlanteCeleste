/** Pannello dei livelli: cosa mostrare, legenda dei colori, qualità grafica. */

import { decimalSep, t } from '../core/i18n';
import { GROUP_COLORS, GROUP_LABELS } from '../data/classes';
import type { Layers } from '../render/view';
import { KIND_COLORS } from '../render/orbits';
import { SAT_CATEGORIES } from '../render/satellites';
import { h } from './dom';
import { tempToCss } from '../core/stellar';

type Key = keyof Layers;

export class LayersPanel {
  readonly root: HTMLElement;
  onChange: () => void = () => {};
  onMagLimit: (v: number) => void = () => {};
  onTextureRes: (hi: boolean) => void = () => {};
  onSatCategory: (i: number, on: boolean) => void = () => {};
  onStarColors: (vivid: boolean) => void = () => {};
  onFpsCap: (fps: number) => void = () => {};
  /** qui va il riquadro "Più stelle dal satellite Gaia" */
  readonly starSlot = h('div', { class: 'star-slot' });
  private magInput: HTMLInputElement | null = null;
  private inputs = new Map<Key, HTMLInputElement>();

  /** Riallinea una casella dopo un cambio fatto da tastiera. */
  sync(key: Key): void {
    const i = this.inputs.get(key);
    if (i) i.checked = this.layers[key];
  }

  constructor(parent: HTMLElement, private layers: Layers, magLimit: number, hiTextures: boolean, satMask: number[], vividStars = true, fpsCap = 60) {
    const toggle = (key: Key, label: string, color?: string) => {
      const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
      this.inputs.set(key, input);
      input.checked = this.layers[key];
      input.addEventListener('change', () => {
        this.layers[key] = input.checked;
        this.onChange();
      });
      return h('label', { class: 'toggle' }, input, color ? h('span', { class: 'swatch', style: { background: color } }) : null, h('span', {}, label));
    };
    const mag = h('input', { type: 'range', min: '3', max: '9.5', step: '0.1', value: String(magLimit), 'aria-label': t('Magnitudine limite') }) as HTMLInputElement;
    const magOut = h('output', {}, magLimit.toFixed(1).replace('.', decimalSep()));
    this.magInput = mag;
    mag.addEventListener('input', () => {
      magOut.textContent = parseFloat(mag.value).toFixed(1).replace('.', decimalSep());
      this.onMagLimit(parseFloat(mag.value));
    });
    const vivid = h('input', { type: 'checkbox' }) as HTMLInputElement;
    vivid.checked = vividStars;
    vivid.addEventListener('change', () => this.onStarColors(vivid.checked));
    // legenda: il colore dice la temperatura della superficie (classe spettrale)
    const spectral: [string, number, string][] = [
      ['O', 40000, t('oltre 30.000 K')], ['B', 15000, '10.000-30.000 K'], ['A', 8500, '7.500-10.000 K'],
      ['F', 6500, '6.000-7.500 K'], ['G', 5600, t('5.200-6.000 K (il Sole)')], ['K', 4400, '3.900-5.200 K'], ['M', 3200, t('sotto i 3.900 K')],
    ];
    const legend = h('div', { class: 'spectral-legend', title: t('Classi spettrali: dalla più calda alla più fredda') },
      ...spectral.map(([k, T, txt]) => {
        const css = tempToCss(T);
        return h('span', { class: 'spec', title: t('Classe {k}: {txt}', { k, txt }) }, h('i', { style: { background: css } }), k);
      }));
    const fps = h('select', { 'aria-label': t('Fotogrammi al secondo') },
      ...[[30, t('30 (risparmio energetico)')], [60, t('60 (consigliato)')], [0, t('quanti ne regge il monitor')]].map(([v, t]) =>
        h('option', { value: String(v), selected: v === fpsCap }, String(t)))) as HTMLSelectElement;
    fps.addEventListener('change', () => this.onFpsCap(parseInt(fps.value, 10)));
    const hi = h('input', { type: 'checkbox' }) as HTMLInputElement;
    hi.checked = hiTextures;
    hi.addEventListener('change', () => this.onTextureRes(hi.checked));

    const satToggles = SAT_CATEGORIES.map((c, i) => {
      const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
      input.checked = satMask[i] > 0;
      input.addEventListener('change', () => this.onSatCategory(i, input.checked));
      return h('label', { class: 'toggle sub' }, input, h('span', { class: 'swatch', style: { background: c.color } }), h('span', {}, c.label));
    });

    this.root = h('div', { class: 'layers panel', role: 'dialog', 'aria-label': t('Livelli') },
      h('h3', {}, t('Corpi del catalogo')),
      toggle('planets', t('Pianeti'), KIND_COLORS.planet),
      toggle('dwarfs', t('Pianeti nani'), KIND_COLORS.dwarf),
      toggle('moons', t('Lune'), KIND_COLORS.moon),
      toggle('comets', t('Comete notevoli'), KIND_COLORS.comet),
      toggle('asteroids', t('Asteroidi notevoli'), KIND_COLORS.asteroid),
      toggle('spacecraft', t('Sonde spaziali'), KIND_COLORS.spacecraft),
      h('h3', {}, t('Popolazioni')),
      toggle('sb_principali', t('{gruppo} e troiani', { gruppo: GROUP_LABELS[0] }), GROUP_COLORS[0]),
      toggle('sb_neo', t('Asteroidi near-Earth'), GROUP_COLORS[1]),
      toggle('sb_tno', GROUP_LABELS[4], GROUP_COLORS[4]),
      toggle('sb_comete', t('Tutte le comete conosciute'), GROUP_COLORS[6]),
      toggle('satellites', t('Satelliti artificiali'), KIND_COLORS.satellite),
      h('div', { class: 'sub-list' }, ...satToggles),
      h('h3', {}, t('Oltre il Sistema Solare')),
      toggle('galaxy', t('Via Lattea (modello)'), '#f2e6cc'),
      toggle('deepsky', t('Nebulose, ammassi, galassie, bracci'), KIND_COLORS.nebula),
      h('h3', {}, t('Cielo e grafica')),
      toggle('stars', t('Stelle')),
      h('label', { class: 'slider' }, h('span', {}, t('Stelle visibili fino alla magnitudine')), magOut, mag),
      h('label', { class: 'toggle' }, vivid, h('span', {}, t('Colori delle stelle accentuati'))),
      legend,
      this.starSlot,
      toggle('constellations', t('Costellazioni (figure e nomi)'), '#6f93cc'),
      toggle('exoplanets', t('Esopianeti e le loro stelle'), '#ffb38a'),
      toggle('regions', t('Zone e confini (zona abitabile, Kuiper, eliopausa, Oort, punti di Lagrange)'), '#4fd18b'),
      toggle('places', t('Luoghi sulle superfici (mari, crateri, missioni)'), '#e9e6dc'),
      toggle('orbits', t('Orbite')),
      toggle('trails', t('Traiettorie delle sonde')),
      toggle('axis', t('Asse di rotazione ed equatore (corpo selezionato)')),
      toggle('magnetic', t('Campo magnetico del corpo selezionato (M)'), '#7ad7ff'),
      toggle('labels', t('Nomi')),
      h('label', { class: 'toggle' }, hi, h('span', {}, t('Texture ad alta risoluzione (8K, più lente da caricare)'))),
      h('label', { class: 'select-row' }, h('span', {}, t('Fotogrammi al secondo')), fps),
    );
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }

  /** Con un catalogo più profondo (Gaia) la magnitudine limite può scendere di più. */
  setMagMax(max: number): void {
    if (this.magInput) this.magInput.max = String(max);
  }
}
