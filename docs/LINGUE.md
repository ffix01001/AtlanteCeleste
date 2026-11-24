# Lingue dell'interfaccia

Atlante Celeste parla italiano, inglese, spagnolo, tedesco e francese. La lingua si sceglie
dal menu in alto a destra (accanto a «?»); al primo avvio si prende quella del sistema
(se non è fra queste, l'inglese). Cambiando lingua la pagina si ricarica.

## Come funziona

- **Scritte dell'interfaccia** (`frontend/src`): sono scritte in italiano dentro `t('...')`.
  L'italiano fa da chiave: `t('Livelli')` diventa «Layers» in inglese.
  I segnaposto si scrivono fra graffe: `t('Distanza da {name}: {main}', { name, main })`.
  I plurali usano `tn(n, '{n} minuto', '{n} minuti')`.
  Il modulo è `frontend/src/core/i18n.ts`.
- **Dizionari**: `frontend/src/i18n/<lingua>.json`, nella forma `{ "testo italiano": "traduzione" }`.
  Per un plurale il valore può essere `{ "one": "...", "other": "..." }` (anche `few`, `many`).
  Se una scritta manca si usa l'inglese, poi l'italiano: l'interfaccia non resta mai vuota.
- **Numeri e date** seguono la lingua (in italiano: virgola decimale, «17 novembre 2026»).
- **Catalogo dei corpi**: `data/catalog_i18n/<lingua>.json` traduce i campi del catalogo per id
  (`name`, `wiki` = titolo della voce di Wikipedia in quella lingua, e i testi in `phys`, `magnetic`...).
  Il nome italiano resta cercabile.
- **Schede**: `data/content/<lingua>/<slug>.md` (se manca: inglese, poi italiano).
- **Dati di riferimento**: `data/reference/<nome>_<lingua>.json` accanto all'originale
  (per esempio `costellazioni_en.json`, `luoghi_superfici_en.json`, `stelle_nomi_en.json`).
- **Schermata d'avvio**: usa l'ultima lingua scelta (salvata in `data/cache/lingua.txt`).

## Strumenti

```
cd frontend
node tools/i18n_keys.mjs                 # quante scritte ci sono e quante mancano per lingua
node tools/i18n_keys.mjs --missing en    # le scritte che mancano in inglese (JSON da tradurre)
node tools/i18n_wrap.mjs file.ts         # trova scritte italiane non ancora dentro t()
```

`tools/i18n_chiavi.json` è l'elenco completo delle scritte con il file in cui compaiono.
