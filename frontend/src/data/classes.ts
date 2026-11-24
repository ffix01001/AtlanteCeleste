/** Classi orbitali del JPL Small-Body Database, con nomi italiani e colori. */

import { t } from '../core/i18n';

export const ORBIT_CLASS_IT: Record<string, string> = {
  MBA: t('Asteroide della fascia principale'),
  IMB: t('Asteroide della fascia principale interna'),
  OMB: t('Asteroide della fascia principale esterna'),
  MCA: t('Asteroide che incrocia l\'orbita di Marte'),
  APO: t('Asteroide near-Earth (gruppo Apollo)'),
  ATE: t('Asteroide near-Earth (gruppo Aten)'),
  AMO: t('Asteroide near-Earth (gruppo Amor)'),
  IEO: t('Asteroide near-Earth (gruppo Atira)'),
  TJN: t('Asteroide troiano di Giove'),
  CEN: t('Centauro'),
  TNO: t('Oggetto transnettuniano'),
  PAA: t('Asteroide su orbita parabolica'),
  HYA: t('Asteroide su orbita iperbolica'),
  AST: t('Asteroide'),
  JFc: t('Cometa della famiglia di Giove'),
  JFC: t('Cometa della famiglia di Giove'),
  HTC: t('Cometa di tipo Halley'),
  ETc: t('Cometa di tipo Encke'),
  CTc: t('Cometa di tipo Chirone'),
  COM: t('Cometa'),
  PAR: t('Cometa su orbita parabolica'),
  HYP: t('Cometa su orbita iperbolica'),
};

/** Gruppo grafico (colore) per ogni classe. */
export function classGroup(code: string): number {
  switch (code) {
    case 'APO': case 'ATE': case 'AMO': case 'IEO': return 1;
    case 'TJN': return 2;
    case 'CEN': return 3;
    case 'TNO': return 4;
    case 'PAA': case 'HYA': return 5;
    case 'JFc': case 'JFC': case 'ETc': case 'CTc': return 6;
    case 'HTC': case 'COM': case 'PAR': case 'HYP': return 7;
    default: return 0;
  }
}

export const GROUP_COLORS = ['#8f8b82', '#ff7a8a', '#86c27e', '#c792dc', '#8ea6ff', '#ffffff', '#7fe0e0', '#b5f2ff'];
export const GROUP_LABELS = [
  t('Fascia principale'), t('Near-Earth'), t('Troiani di Giove'), t('Centauri'), t('Transnettuniani'), t('Orbite aperte'),
  t('Comete periodiche brevi'), t('Comete di lungo periodo'),
];

export function isCometClass(code: string): boolean {
  return classGroup(code) >= 6;
}
