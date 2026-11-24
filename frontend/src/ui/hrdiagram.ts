/**
 * Diagramma di Hertzsprung-Russell: ogni stella del catalogo è un punto secondo il suo
 * colore (cioè la temperatura: a sinistra le calde e azzurre, a destra le fredde e rosse)
 * e la sua luminosità vera (in alto le più luminose). Le stelle non si spargono a caso ma
 * si raccolgono in "famiglie": la sequenza principale, le giganti, le supergiganti, le
 * nane bianche. Il punto evidenziato mostra dove sta la stella selezionata.
 */

import { locale, t } from '../core/i18n';
import { Color } from 'three';
import type { HrHistogram } from '../data/api';
import { bvToTemp, tempToBv, tempToColor, tempToCss } from '../core/stellar';

const W = 640, H = 480;               // risoluzione interna (il CSS lo adatta alla larghezza del pannello)
const PAD = { l: 112, r: 16, t: 16, b: 84 };
const INK = '#e9e6dc', INK3 = 'rgba(170, 176, 189, 0.9)', BRASS = '#c9a45c';
const FONT = '"IBM Plex Sans", system-ui, sans-serif';

export interface HrMarker {
  bv: number;
  mag: number;
  label: string;
}

export function hrDiagram(hist: HrHistogram, star: HrMarker | null): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  cv.className = 'hr-diagram';
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', star
    ? t('Diagramma di Hertzsprung-Russell con {label} evidenziata', { label: star.label })
    : t('Diagramma di Hertzsprung-Russell'));
  const g = cv.getContext('2d');
  if (!g) return cv;

  const [b0, b1, nb] = hist.bv;
  const [m0, m1, nm] = hist.mag;
  const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  const xOf = (bv: number) => PAD.l + ((bv - b0) / (b1 - b0)) * pw;
  const yOf = (m: number) => PAD.t + ((m - m0) / (m1 - m0)) * ph; // magnitudini piccole (luminose) in alto
  const col = new Color();

  // nuvola delle stelle: una casella = un pixel di un'immagine piccola, poi ingrandita e
  // sfumata. Intensità in scala logaritmica, colore = colore delle stelle di quella colonna.
  const max = Math.max(1, ...hist.counts);
  const small = document.createElement('canvas');
  small.width = nb;
  small.height = nm;
  const sg = small.getContext('2d');
  if (sg) {
    const img = sg.createImageData(nb, nm);
    for (let i = 0; i < nb; i++) {
      const hex = tempToColor(bvToTemp(b0 + ((i + 0.5) / nb) * (b1 - b0)), col).getHex(); // sRGB
      for (let j = 0; j < nm; j++) {
        const n = hist.counts[j * nb + i];
        if (!n) continue;
        const k = (j * nb + i) * 4;
        img.data[k] = (hex >> 16) & 255;
        img.data[k + 1] = (hex >> 8) & 255;
        img.data[k + 2] = hex & 255;
        img.data[k + 3] = 255 * (0.22 + 0.78 * (Math.log1p(n) / Math.log1p(max)));
      }
    }
    sg.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, PAD.l, PAD.t, pw, ph);
  }

  // cornice e assi
  g.strokeStyle = 'rgba(233, 230, 220, 0.18)';
  g.lineWidth = 1.5;
  g.strokeRect(PAD.l, PAD.t, pw, ph);
  g.font = `23px ${FONT}`;
  g.fillStyle = INK3;
  g.textBaseline = 'middle';

  // asse verticale: luminosità rispetto al Sole (magnitudine assoluta 4,83 = 1)
  g.textAlign = 'right';
  const lumTicks: [number, string][] = [[-5.17, '10.000×'], [-0.17, '100×'], [4.83, '1×'], [9.83, '1/100'], [14.83, '1/10.000']];
  for (const [m, txt] of lumTicks) {
    const y = yOf(m);
    g.fillText(txt, PAD.l - 12, y);
    g.fillRect(PAD.l - 7, y - 0.75, 7, 1.5);
  }
  g.save();
  g.translate(20, PAD.t + ph / 2);
  g.rotate(-Math.PI / 2);
  g.textAlign = 'center';
  g.fillText(t('luminosità (Sole = 1)'), 0, 0);
  g.restore();

  // asse orizzontale: temperatura della superficie
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (const T of [10000, 6000, 4000, 3000]) {
    const x = xOf(tempToBv(T));
    if (x < PAD.l || x > PAD.l + pw) continue;
    g.fillRect(x - 0.75, PAD.t + ph, 1.5, 7);
    g.fillText(`${T.toLocaleString(locale())} K`, x, PAD.t + ph + 12);
  }
  g.fillText(t('← più calde        temperatura        più fredde →'), PAD.l + pw / 2, PAD.t + ph + 46);

  // nomi delle famiglie
  g.font = `italic 23px ${FONT}`;
  g.fillStyle = 'rgba(233, 230, 220, 0.7)';
  g.textBaseline = 'middle';
  const region = (bv: number, m: number, txt: string, rot = 0) => {
    g.save();
    g.translate(xOf(bv), yOf(m));
    g.rotate(rot);
    g.textAlign = 'center';
    g.fillText(txt, 0, 0);
    g.restore();
  };
  region(0.15, -7.8, t('supergiganti'));
  region(1.18, 2.4, t('giganti'));
  region(0.42, 8.2, t('sequenza principale'), 0.57);
  region(0.25, 15.6, t('nane bianche'));

  // il Sole come riferimento
  const sx = xOf(0.65), sy = yOf(4.83);
  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(sx, sy, 8, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(sx, sy, 2, 0, Math.PI * 2);
  g.fill();
  g.font = `21px ${FONT}`;
  g.textAlign = 'left';
  g.fillText(t('Sole'), sx + 13, sy + 14);

  // la stella selezionata
  if (star && Number.isFinite(star.bv) && Number.isFinite(star.mag)) {
    const x = Math.min(Math.max(xOf(star.bv), PAD.l), PAD.l + pw);
    const y = Math.min(Math.max(yOf(star.mag), PAD.t), PAD.t + ph);
    g.strokeStyle = 'rgba(201, 164, 92, 0.5)';
    g.lineWidth = 1.5;
    g.setLineDash([6, 7]);
    g.beginPath();
    g.moveTo(PAD.l, y); g.lineTo(PAD.l + pw, y);
    g.moveTo(x, PAD.t); g.lineTo(x, PAD.t + ph);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = BRASS;
    g.lineWidth = 3.5;
    g.beginPath();
    g.arc(x, y, 13, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = tempToCss(bvToTemp(star.bv));
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
    // etichetta: dalla parte libera del grafico
    g.font = `600 24px ${FONT}`;
    g.fillStyle = BRASS;
    const right = x > PAD.l + pw * 0.6;
    const below = y < PAD.t + 90;
    g.textAlign = right ? 'right' : 'left';
    g.fillText(star.label, x + (right ? -22 : 22), y + (below ? 26 : -26));
  }
  return cv;
}
