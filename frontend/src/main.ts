import '@fontsource-variable/bodoni-moda/index.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import './styles.css';
import { registraAutore } from './core/autore';
import { loadLanguage } from './core/i18n';

registraAutore();

// prima il dizionario della lingua, poi l'app (le sue scritte si traducono appena caricate)
const dictionaries = import.meta.glob('./i18n/*.json');
await loadLanguage(Object.fromEntries(Object.entries(dictionaries).map(([path, load]) => [path.slice('./i18n/'.length, -'.json'.length), load])));
const { App } = await import('./app');
const root = document.getElementById('app')!;
const app = new App(root);
void app.start();
// utile per esplorare dalla console del browser
(window as unknown as { atlante: unknown }).atlante = app;
