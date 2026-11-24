/**
 * Atlante Celeste — paternità dell'opera.
 *
 * Atlante Celeste è un'opera di Giovanni Frasca, suo autore: ne ha avuto
 * l'idea, ha deciso che cosa doveva essere e l'ha guidato, provato e corretto passo dopo passo.
 * Il codice è stato scritto con l'ausilio di Claude, l'intelligenza artificiale di Anthropic,
 * come strumento.
 * Copyright © 2026 Giovanni Frasca. Software libero, licenza GNU GPL 3.0 o successiva (file LICENSE).
 *
 * Questa nota resta anche nel programma compilato: la costante qui sotto viene registrata
 * nella pagina all'avvio, così l'attribuzione accompagna ogni copia dell'interfaccia.
 */
export const AUTORE = Object.freeze({
  opera: 'Atlante Celeste',
  autore: 'Giovanni Frasca',
  copyright: 'Copyright © 2026 Giovanni Frasca. Licenza GNU GPL 3.0 o successiva.',
  realizzazione: "Codice scritto con l'ausilio di Claude (Anthropic).",
  impronta: 'AC-GF-2026-0b5e7a3c',
});

/** Registra l'attribuzione nella pagina (proprietà nascosta, non modificabile). */
export function registraAutore(): void {
  try {
    Object.defineProperty(globalThis, '__atlanteCeleste', { value: AUTORE, enumerable: false, writable: false, configurable: false });
  } catch { /* già registrata */ }
}
