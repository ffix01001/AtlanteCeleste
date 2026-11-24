/** Guida rapida: comandi del mouse e scorciatoie da tastiera. */

import { t } from '../core/i18n';
import { h } from './dom';

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

const KEYS: [string, string][] = [
  [t('Trascina'), t('Ruota la vista attorno al corpo inquadrato')],
  [IS_MAC ? t('Rotella o pizzico') : t('Rotella'), t('Avvicinati o allontanati')],
  [t('Clic'), t('Seleziona un corpo e mostra la sua scheda')],
  [t('Doppio clic'), t('Seleziona e vola fino al corpo')],
  ['/', t('Cerca')],
  [t('Spazio'), t('Pausa o riprendi il tempo')],
  [', e .', t('Rallenta o accelera il tempo (sotto zero si va indietro)')],
  ['N', t('Torna all\'istante presente')],
  ['F', t('Inquadra il corpo selezionato')],
  ['S', t('Torna al Sole')],
  ['V', t('Volo libero: muoviti nello spazio come con un\'astronave (di nuovo V per tornare all\'orbita)')],
  ['M', t('Mostra o nascondi il campo magnetico del corpo selezionato')],
  ['P', t('Fotografa la scena (l\'immagine va nella cartella «immagini» del progetto)')],
  ['T', t('Cielo visto da terra, dal luogo scelto in Eventi (di nuovo T per tornare nello spazio)')],
  ['G', t('Vola fuori dalla Galassia (vista della Via Lattea)')],
  ['E', t('Eventi in cielo: eclissi, opposizioni, meteore, asteroidi in arrivo')],
  ['L', t('Mostra o nascondi i livelli')],
  ['H', t('Nascondi l\'interfaccia (per gli screenshot)')],
  [IS_MAC ? t('Ctrl Cmd F') : 'F11', t('Schermo intero')],
  [t('Clic su un luogo'), t('Sulla superficie di un corpo: apre la descrizione del luogo (mare, cratere, sito di atterraggio)')],
  [t('Esc'), t('Chiudi la scheda')],
];

/** Comandi validi solo in volo libero (lì S ed E muovono la camera). */
const FLIGHT_KEYS: [string, string][] = [
  ['W A S D', t('Avanti, a sinistra, indietro, a destra (anche con le frecce)')],
  ['Q e E', t('Giù e su')],
  [t('Trascina'), t('Guardati intorno')],
  [IS_MAC ? t('Rotella o pizzico') : t('Rotella'), t('Una spinta in avanti o indietro')],
  [t('Shift'), t('Cinque volte più veloce, finché lo tieni premuto')],
  ['+ e −', t('Raddoppia o dimezza la velocità')],
  ['Z e C', t('Ruota su te stesso')],
  ['R', t('Raddrizza la vista (l\'alto verso il nord dell\'eclittica)')],
  [t('F o doppio clic'), t('Vola fino al corpo e torna a girargli attorno')],
];

export class HelpPanel {
  readonly root: HTMLElement;
  constructor(parent: HTMLElement) {
    this.root = h('div', { class: 'help panel', role: 'dialog', 'aria-label': t('Comandi') },
      h('h3', {}, t('Comandi')),
      h('dl', { class: 'keys' }, ...KEYS.map(([k, v]) => h('div', { class: 'row' }, h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)))),
      h('h3', {}, t('In volo libero')),
      h('p', { class: 'muted small' }, t('La velocità si adatta da sola: piano vicino a un asteroide, velocissimi fra le stelle. Non ci si schianta mai.')),
      h('dl', { class: 'keys' }, ...FLIGHT_KEYS.map(([k, v]) => h('div', { class: 'row' }, h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)))),
      h('h3', {}, t('Crediti')),
      h('p', { class: 'small credits-author' },
        h('strong', {}, 'Atlante Celeste'), t(' © 2026 Giovanni Frasca, autore e padre del progetto. Software libero, licenza GNU GPL 3.0. '),
        t('Scritto insieme a Claude, l\'intelligenza artificiale di Anthropic (la "mamma", come dice Giovanni).')),
      h('p', { class: 'muted small' },
        t('Posizioni: NASA/JPL Horizons, Small-Body Database e CNEOS; CelesTrak (satelliti). '),
        t('Stelle: catalogo HYG v4.1 di David Nash (CC BY-SA 4.0) e, se scaricato dal pannello dei livelli, Gaia DR3 '),
        t('(ESA/Gaia/DPAC, CC BY-SA 3.0 IGO). Stelle S: Gillessen et al. 2017 (ESO). Bracci della Via Lattea: Reid et al. 2019; forma della Galassia per la luce diffusa e le stelle generate: Bland-Hawthorn e Gerhard 2016. '),
        t('Distanze: GRAVITY Collaboration e altri articoli citati nelle schede. Lampi di Sagittarius A*: GRAVITY Collaboration 2018. Buco nero che ruota: R. P. Kerr 1963; Bardeen, Press e Teukolsky 1972; Bardeen 1973. Luoghi sulle superfici: Gazetteer of Planetary Nomenclature (IAU/USGS). Pleiadi e Iadi in 3D: Lodieu et al. 2019, Röser et al. 2011; '),
        t('forma delle Nubi di Magellano: Inno et al. 2016, Subramanian e Subramaniam 2015 (Cefeidi). '),
        t('Campi magnetici: MESSENGER, WMM2025 e IGRF-14, Juno (JRM09), Cassini, Voyager 2, Galileo per Ganimede (fonti nelle schede).')),
      h('p', { class: 'muted small' },
        t('Texture: Solar System Scope (CC BY 4.0) e progetto Celestia (Urano, Nettuno, lune, pianeti nani e asteroidi; '),
        t('autori e licenze nelle schede). Foto del cielo profondo: Stellarium e gli astrofotografi citati nelle schede. '),
        t('Modelli 3D delle sonde: NASA 3D Resources (la NASA non approva né sostiene questo progetto); per le sonde senza '),
        t('un modello pubblico, versioni semplificate sulle dimensioni vere.')),
      h('p', { class: 'muted small' },
        t('Eventi: Astronomy Engine di Don Cross (MIT), International Meteor Organization. Luoghi: Open-Meteo e GeoNames (CC BY 4.0). '),
        t('Testi: Wikipedia (CC BY-SA 4.0). Software: three.js, satellite.js, marked (MIT); caratteri Bodoni Moda e IBM Plex Sans (OFL); '),
        t('FastAPI, Uvicorn, httpx, NumPy, pywebview. Elenco completo e licenze nei file CREDITI.md e LICENZE_TERZE_PARTI.txt.')),
    );
    this.root.hidden = true;
    parent.appendChild(this.root);
  }
  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }
}
