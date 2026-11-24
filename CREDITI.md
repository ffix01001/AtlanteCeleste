# Atlante Celeste: crediti

**Atlante Celeste** è un'idea di **Giovanni Frasca**, che ne è l'autore e il padre: ha deciso che cosa
doveva essere, l'ha guidato passo dopo passo, l'ha provato e corretto.
© 2026 Giovanni Frasca. Software libero: codice con licenza GNU GPL 3.0 o successiva (`LICENSE`),
testi delle schede con licenza CC BY-SA 4.0 (`data/content/LICENZA.md`).

Il codice è stato scritto insieme a **Claude**, l'intelligenza artificiale di **Anthropic**: se Giovanni
è il padre del progetto, Claude, come dice lui, ne è "la mamma".

Un planetario come questo esiste solo grazie al lavoro di tanti altri: scienziati, missioni spaziali,
archivi pubblici, artisti e programmatori che condividono i loro dati, le loro immagini e il loro
software. Eccoli tutti.

## Dati scientifici

| Che cosa | Da chi | Licenza o condizioni |
|---|---|---|
| Posizioni di Sole, pianeti, lune, sonde e corpi notevoli | NASA/JPL, [Horizons](https://ssd.jpl.nasa.gov/horizons/) | dati pubblici (cortesia NASA/JPL-Caltech) |
| Asteroidi e comete; passaggi ravvicinati alla Terra | NASA/JPL, [Small-Body Database](https://ssd.jpl.nasa.gov/tools/sbdb_query.html) e [CNEOS](https://cneos.jpl.nasa.gov/ca/) | dati pubblici (cortesia NASA/JPL-Caltech) |
| Satelliti attorno alla Terra | [CelesTrak](https://celestrak.org/), T.S. Kelso | uso libero; la cache rispetta la richiesta di non scaricare più di una volta ogni due ore |
| Stelle (circa 110.000) | [HYG Database v4.1](https://github.com/astronexus/HYG-Database), David Nash (astronexus) | CC BY-SA 4.0 |
| Stelle in più, scaricabili dal programma | missione [Gaia](https://www.cosmos.esa.int/gaia) dell'ESA, catalogo DR3 (vedi sotto) | CC BY-SA 3.0 IGO |
| Orbite delle stelle S attorno a Sagittarius A* | S. Gillessen et al. 2017, ApJ 837, 30 (ESO) | dati pubblicati |
| Distanze: Sagittarius A* (GRAVITY Collaboration 2021), Nubi di Magellano (Pietrzyński et al. 2019, Graczyk et al. 2020), Omega Centauri (Baumgardt & Vasiliev 2021), M16 (Kuhn et al. 2019), Pleiadi e Iadi (Gaia) | articoli scientifici | dati pubblicati |
| Aspetto di Sagittarius A* | ispirato all'immagine dell'[Event Horizon Telescope](https://eventhorizontelescope.org/) (2022) | ricostruzione disegnata dal programma |
| Pleiadi e Iadi stella per stella (raggio di metà massa, raggio mareale, numero di stelle) | N. Lodieu et al. 2019, A&A 628, A66 (Pleiadi); S. Röser et al. 2011, A&A 531, A92 (Iadi) | dati pubblicati |
| Forma 3D delle Nubi di Magellano (inclinazione e linea dei nodi del disco, spessore) | L. Inno et al. 2016, ApJ 832, 176 (Grande Nube); S. Subramanian e A. Subramaniam 2015, A&A 573, A135 (Piccola Nube) | dati pubblicati |
| Bracci a spirale della Via Lattea | M. J. Reid et al. 2019, ApJ 885, 131 | dati pubblicati |
| Forma della Via Lattea per la luce diffusa e le stelle generate (dischi, barra, bulge) | valori tipici da J. Bland-Hawthorn e O. Gerhard 2016, ARA&A 54, 529 | dati pubblicati |
| Eclissi, fasi, opposizioni, stagioni | [Astronomy Engine](https://github.com/cosinekitty/astronomy), Don Cross | MIT |
| Piogge di meteore | [International Meteor Organization](https://www.imo.net/) | dati pubblicati |
| Orientamento dei pianeti | IAU WGCCRE (Archinal et al.) | dati pubblicati |
| Figure delle costellazioni (linee e posizione dei nomi) | [d3-celestial](https://github.com/ofrohn/d3-celestial), © 2015 Olaf Frohn | BSD a 3 clausole (testo in `data/reference/LICENZA_d3-celestial.txt`) |
| Anelli di Giove, Urano e Nettuno (raggi e larghezze) | missioni Voyager, Galileo e New Horizons; [NASA Planetary Rings Node](https://pds-rings.seti.org/) | dati pubblici |
| Esopianeti e le loro stelle | [NASA Exoplanet Archive](https://exoplanetarchive.ipac.caltech.edu/) (Caltech/IPAC), tabella Planetary Systems Composite Parameters | dati pubblici; scaricati dal programma |
| Nomi e coordinate dei luoghi sulle superfici | [Gazetteer of Planetary Nomenclature](https://planetarynames.wr.usgs.gov/) (IAU/USGS); siti di atterraggio: NASA, ESA, CNSA, ISRO, Roscosmos | dati pubblici |
| Buco nero che ruota: raggi di luce, orizzonte, ergosfera, ultima orbita stabile, bordo dell'ombra | R. P. Kerr 1963, *Physical Review Letters* 11, 237 (soluzione di Kerr, coordinate di Kerr-Schild); J. M. Bardeen, W. H. Press e S. A. Teukolsky 1972, ApJ 178, 347; J. M. Bardeen 1973, *Black Holes* (Les Houches) | formule pubblicate, riscritte nel programma |
| Lampi di Sagittarius A* (macchia calda in orbita) | GRAVITY Collaboration 2018, *Astronomy & Astrophysics* 618, L10 (ESO) | articolo scientifico |
| Zona abitabile | J. F. Kasting et al. 1993, Icarus 101; R. K. Kopparapu et al. 2013, ApJ 765 | dati pubblicati |
| Shock di terminazione ed eliopausa | sonde Voyager 1 e 2 (NASA/JPL) | dati pubblici |
| Campi magnetici: Mercurio | B. J. Anderson et al. 2012 (MESSENGER), JGR 117 | dati pubblicati |
| Campi magnetici: Terra | [WMM2025](https://www.ncei.noaa.gov/products/world-magnetic-model) (NOAA/BGS) e IGRF-14 (IAGA) | dati pubblici |
| Campi magnetici: Giove | modello JRM09, J. E. P. Connerney et al. 2018 (Juno), GRL 45 | dati pubblicati |
| Campi magnetici: Saturno | H. Cao et al. 2020 (Cassini Grand Finale), Icarus 344 | dati pubblicati |
| Campi magnetici: Urano e Nettuno | N. F. Ness et al. 1986 e 1989 (Voyager 2), Science | dati pubblicati |
| Campi magnetici: Ganimede | M. G. Kivelson et al. 2002 (sonda Galileo), Icarus 157 | dati pubblicati |
| Campi magnetici: Sole | dipolo con superficie sorgente, M. D. Altschuler e G. Newkirk 1969; K. H. Schatten, J. M. Wilcox e N. F. Ness 1969, Solar Physics | metodo pubblicato, riscritto nel programma |
| Differenza fra ora civile e tempo uniforme (ΔT) | F. Espenak e J. Meeus (NASA), tramite Astronomy Engine; secondi intercalari: IERS | dati pubblici |
| Distanze delle magnetopause | M. G. Kivelson e F. Bagenal 2007, *Encyclopedia of the Solar System* | dati pubblicati |
| Modello del campo vicino al vento solare | dipolo immagine (Chapman e Ferraro 1931), strato di corrente (Harris 1962), forma della magnetopausa (Shue et al. 1997) | metodi pubblicati, riscritti nel programma |
| Atmosfere: diffusione della luce | coefficienti di Rayleigh e Mie come in E. Bruneton e F. Neyret 2008; funzione di Chapman approssimata come in C. Schüler 2012 (*GPU Pro 3*) | metodi pubblicati, riscritti nel programma |
| Voli morbidi della camera | J. J. van Wijk e W. A. A. Nuij 2003, *Smooth and efficient zooming and panning* | metodo pubblicato, riscritto nel programma |
| Ricerca dei luoghi | [Open-Meteo](https://open-meteo.com/) con i dati di [GeoNames](https://www.geonames.org/) | CC BY 4.0 |
| Testi dei corpi senza scheda | [Wikipedia in italiano](https://it.wikipedia.org/) | CC BY-SA 4.0 (riassunto con il collegamento alla voce) |

Ringraziamento richiesto per Gaia: *questo lavoro usa dati della missione Gaia dell'Agenzia Spaziale
Europea (ESA) (https://www.cosmos.esa.int/gaia), elaborati dal Gaia Data Processing and Analysis
Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Il DPAC è finanziato da
istituzioni nazionali, in particolare quelle che partecipano al Gaia Multilateral Agreement.*

## Immagini

| Che cosa | Da chi | Licenza |
|---|---|---|
| Texture di Sole, Mercurio, Venere, Terra, Luna, Marte, Giove, Saturno, anelli e Urano | [Solar System Scope](https://www.solarsystemscope.com/textures/) (INOVE), su dati NASA | CC BY 4.0 |
| Texture di Plutone e Caronte | NASA/Johns Hopkins University APL/Southwest Research Institute, sonda New Horizons ([PIA11707](https://science.nasa.gov/image-detail/amf-pia11707/), [PIA21860](https://science.nasa.gov/photojournal/charons-surface-in-detail/)); zone mai fotografate riempite e colore della calotta nord di Caronte aggiunto da Atlante Celeste (`scripts/prepara_texture_libere.py`) | materiale NASA, uso libero |
| Texture di Nettuno, 35 lune, pianeti nani e asteroidi | progetto [Celestia](https://github.com/CelestiaProject/CelestiaContent): Askaniy Anpilogov, Björn Jónsson, Paul Schenk, Ted Stryk, Phil Stooke, John van Vliet, ItzImcool, Roman Tkachenko e altri, da immagini di Voyager, Galileo, Cassini, New Horizons, Dawn, Hubble | una licenza per ogni mappa (CC0, CC BY, CC BY-SA, GPL): autori e licenza nella scheda di ogni corpo e in `data/assets/textures/manifest.json` |
| Foto di nebulose, ammassi e galassie | planetario [Stellarium](https://github.com/Stellarium/stellarium) e i singoli astrofotografi indicati nella scheda di ogni oggetto | distribuite con Stellarium (GPL-2.0 o successiva), diritti dei singoli autori |
| Modelli 3D delle sonde e della Stazione Spaziale | [NASA 3D Resources](https://science.nasa.gov/3d-resources/) | materiale NASA, uso libero; la NASA non approva né sostiene questo progetto |
| Superfici di Sedna, Eris, Haumea, Makemake e Nereide | generate dal programma | nessuna sonda le ha mai fotografate: sono indicative |

## Software

- [three.js](https://threejs.org/) (MIT): la grafica 3D.
- [Astronomy Engine](https://github.com/cosinekitty/astronomy) (MIT), [satellite.js](https://github.com/shashwatak/satellite-js) (MIT), [marked](https://marked.js.org/) (MIT).
- Caratteri [Bodoni Moda](https://github.com/indestructible-type/Bodoni) e [IBM Plex Sans](https://github.com/IBM/plex) (SIL Open Font License 1.1), tramite Fontsource.
- Server: [FastAPI](https://fastapi.tiangolo.com/) (MIT), [Uvicorn](https://www.uvicorn.org/) (BSD), [httpx](https://www.python-httpx.org/) (BSD), [NumPy](https://numpy.org/) (BSD); finestra del programma: [pywebview](https://pywebview.flowrl.com/) (BSD).
- Strumenti: [Vite](https://vite.dev/), [TypeScript](https://www.typescriptlang.org/), [uv](https://docs.astral.sh/uv/).

Il testo completo delle licenze di queste librerie è in `LICENZE_TERZE_PARTI.txt`
(si rigenera con `scripts/genera_licenze.py`).

## Le licenze sono rispettate?

Sì. Atlante Celeste è software libero (codice GNU GPL 3.0 o successiva, testi delle schede CC BY-SA 4.0)
e tutti i materiali che usa si possono ridistribuire con lui, anche da altri e anche modificati:

- **attribuzione** (CC BY, CC BY-SA, GeoNames, Wikipedia, Gaia): ogni fonte è citata qui, nella guida
  del programma e, per texture, foto e modelli, nella scheda del corpo. Chi ridistribuisce il
  programma deve lasciare questi crediti;
- **condividi allo stesso modo** (CC BY-SA, GPL): i dati delle stelle derivati da HYG e da Gaia, le
  texture con licenza SA e le foto di Stellarium restano sotto la loro licenza anche dentro Atlante
  Celeste, come opere distinte raccolte insieme al programma;
- **nessuna limitazione commerciale**: non ci sono più materiali "solo uso non commerciale" (le tre
  texture di Celestia con licenza CC BY-NC-SA, di Urano, Plutone e Caronte, sono state sostituite);
- **MIT, BSD, OFL**: il testo delle licenze accompagna il programma (`LICENZE_TERZE_PARTI.txt`);
- **NASA**: si possono usare dati, immagini e modelli, ma non il logo e senza far credere che la NASA
  approvi il progetto.
