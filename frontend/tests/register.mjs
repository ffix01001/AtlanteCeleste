// Per i test con Node: gli import relativi senza estensione (come li scrive Vite) diventano ".ts".
import { register } from 'node:module';
register('./resolve-ts.mjs', import.meta.url);

// I test controllano le scritte italiane: la lingua è fissata all'italiano
// (altrimenti verrebbe presa quella del sistema).
const mem = new Map([['atlante:lang', 'it']]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
});
