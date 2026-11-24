# Architettura di Atlante Celeste

Questo documento spiega le scelte tecniche e perché sono state fatte così, pensando all'obiettivo finale: una mappa navigabile della Via Lattea.

## Due parti separate

```
 Browser (TypeScript + Three.js, WebGL 2)           Server locale (Python + FastAPI)
 ┌──────────────────────────────────────┐           ┌───────────────────────────────────┐
 │ simulazione: tempo, albero dei corpi │  /api/... │ catalogo (data/catalog/*.json)     │
 │ grafica: shader, camera, livelli     │ ────────► │ effemeridi a blocchi + cache       │
 │ interfaccia: pannelli, ricerca       │ ◄──────── │ fonti: Horizons, SBDB, CelesTrak,  │
 │ worker SGP4 per i satelliti          │   JSON /  │        Wikipedia, texture          │
 └──────────────────────────────────────┘   binario └───────────────────────────────────┘
```

- **Il server** non disegna nulla: scarica, normalizza, mette in cache e serve. È in Python perché l'ecosistema astronomico (astropy, astroquery, healpy, l'accesso all'archivio Gaia) è lì: la preparazione dei cataloghi di stelle verrà scritta in Python.
- **Il browser** calcola e disegna. WebGL 2 oggi, WebGPU domani (Three.js lo supporta già): il codice grafico è isolato in `frontend/src/render`.

## Sistemi di riferimento

- **Dati**: ICRF (praticamente l'equatoriale J2000), km e km/s. È il sistema di JPL Horizons e del catalogo Gaia.
- **Albero dei corpi**: ogni corpo ha uno stato *relativo al padre* (Luna → Terra → Sole → baricentro). Le lune si chiedono a JPL già relative al pianeta: più precisione e orbite disegnate correttamente. Quando arriveranno altri sistemi stellari, ogni stella sarà la radice locale del proprio albero.
- **Scena**: solo per la visualizzazione l'ICRF viene ruotato in modo che l'eclittica sia orizzontale (`core/frames.ts`).

## Precisione: origine mobile e profondità logaritmica

La scheda video lavora a 32 bit (circa 7 cifre significative). Se le posizioni fossero assolute, a 30 UA dal Sole l'errore sarebbe di decine di km: la Luna "tremerebbe".

Soluzione: tutte le posizioni restano in **64 bit sulla CPU** (i `Vector3` di Three.js sono numeri JavaScript a doppia precisione). A ogni fotogramma si sottrae la posizione della camera e solo la differenza va alla GPU: vicino alla camera i numeri sono piccoli e precisi.

Per gli oggetti calcolati direttamente sulla GPU (asteroidi) la posizione della camera viene passata divisa in due parti, "alta" e "bassa" (`camHi` + `camLo`), un trucco classico per recuperare precisione.

Il **buffer di profondità logaritmico** permette di avere nella stessa scena oggetti a 1 metro e a 10^18 km senza conflitti di profondità.

## Navigazione: orbita, volo libero e voli morbidi

La camera (`render/camera.ts`) ha due modalità.

- **Orbita**: gira attorno a un corpo (azimut, elevazione, distanza).
- **Volo libero**: posizione e orientamento (quaternione) liberi. La posizione è tenuta **rispetto al corpo più
  vicino** (l'"ancora", con un margine per non saltare avanti e indietro): se il tempo corre veloce la camera segue
  la Luna invece di restare indietro nello spazio. La velocità è proporzionale alla distanza dalla superficie più
  vicina (in un secondo si percorre la distanza che manca), e un fotogramma non può superare i 9/10 di quella
  distanza: così non si attraversa mai un pianeta, a qualunque velocità.

I **voli verso un corpo** usano il percorso di van Wijk e Nuij (2003, `render/camerapath.ts`): punto osservato e
distanza si muovono insieme sul percorso più breve "a velocità costante sullo schermo". Il corpo di arrivo entra
nell'inquadratura presto (prima restava fuori per oltre il 90% del viaggio) e i salti lunghi passano da una vista
più ampia. Due accorgimenti di precisione: le formule sono scritte senza sottrarre numeri enormi quasi uguali, e
nella seconda metà del volo la posizione si conta dall'arrivo (da Andromeda alla Terra l'ultima cifra di un numero
a 64 bit vale migliaia di km). Se si cambia destinazione a metà strada il volo vecchio sfuma nel nuovo, e i cambi di
modalità girano lo sguardo con un passaggio morbido (slerp) invece di uno scatto.

## Atmosfere calcolate

Terra, Marte e Titano hanno un'atmosfera calcolata per ogni pixel (`render/atmosphere.ts`): lungo il raggio di
vista si fanno 24 passi nel guscio, più fitti attorno al punto più basso (dove l'aria è più densa); per ogni passo
la luce del Sole è attenuata con la funzione di Chapman nell'approssimazione di Schüler, che dà anche l'ombra del
pianeta sull'aria. Rayleigh (molecole: il blu) e Mie (polveri e goccioline: alone attorno al Sole, foschia) con i
coefficienti del catalogo (campo `scatter`, per km). Il risultato è un colore premoltiplicato: luce diffusa più velo
sulla scena dietro. Anche la luce che arriva al suolo e sulle nubi attraversa l'aria (`sunThroughAir` in
`shaders.ts`): vicino al terminatore perde il blu. Il parametro `ms` aggiunge in modo approssimato i rimbalzi
multipli (contano per la foschia densa di Titano). Tutto è in raggi del pianeta: numeri piccoli anche in float32.

## Campi magnetici

`render/fieldmodel.ts` somma tre campi: il dipolo del pianeta (inclinato e spostato come misurato), il suo
"dipolo immagine" riflesso nel piano della magnetopausa (Chapman-Ferraro: sul lato giorno il campo non esce verso il
Sole) e lo strato di corrente della coda (Harris: sul lato notte le linee vengono stirate in due lobi). Le linee si
tracciano con Runge-Kutta 4 dalla superficie, su gusci scelti in proporzione alla magnetopausa; si tengono quelle
chiuse e quelle aperte che finiscono nella coda (le altre, collegate al vento solare, sembrerebbero peli). Il dipolo
gira con il pianeta (`magnetosphere.ts`): le linee si ricalcolano quando pianeta o Sole si spostano di 0,35°.

## Effemeridi a blocchi

Il tempo è diviso in blocchi fissi di 32 giorni a partire da J2000. Per ogni corpo il browser chiede il blocco che contiene l'istante simulato (e precarica il successivo quando ci si avvicina al bordo). Il server lo chiede a Horizons una sola volta e lo conserva in SQLite:

- i blocchi passati non scadono quasi mai;
- quelli presenti e futuri si aggiornano ogni pochi giorni (le previsioni delle sonde cambiano dopo le manovre);
- senza rete si usano i blocchi in cache.

Fra un campione e l'altro si usa un polinomio di **Hermite cubico** che rispetta posizione e velocità: per la Luna con passo di 6 ore l'errore è di pochi metri. Il passo di campionamento è scelto per ogni corpo nel catalogo (15 minuti per Fobos, 8 giorni per Nettuno).

Finché un blocco non arriva, il corpo usa un **ripiego** (in ordine): elementi orbitali SBDB, elementi medi di Standish per i pianeti, orbita circolare media per le lune. La scheda indica sempre la fonte.

## Corpi minori sulla GPU

Gli insiemi di asteroidi e comete arrivano dal server in formato **ATBL** (binario a colonne, `backend/atlante/binpack.py`). Ogni punto porta i propri elementi (q, e, i, Ω, ω, tp, già trasformati nei vettori P e Q del piano orbitale) e il vertex shader risolve l'equazione di Keplero per ellissi, parabole e iperboli. La CPU non fa nulla: si possono disegnare centinaia di migliaia di corpi. Per la selezione col clic gli stessi calcoli vengono rifatti in doppia precisione sulla CPU.

## Satelliti terrestri

Gli elementi OMM di CelesTrak vengono propagati con **SGP4** (satellite.js) in un Web Worker, due-tre volte al secondo. Fra un calcolo e l'altro la GPU estrapola linearmente con la velocità. SGP4 restituisce coordinate TEME "della data", convertite in ICRF con la matrice di precessione IAU 1976. Gli elementi valgono solo vicino alla loro epoca: lontano da oggi i satelliti vengono nascosti.

## Stelle: tasselli, colori e tipi

Le stelle sono posizionate in 3D (parsec). Nello shader la magnitudine apparente si calcola da magnitudine assoluta e distanza **dalla camera**: muovendosi fra le stelle il cielo cambia in modo fisicamente corretto.

I cataloghi (HYG sempre presente, Gaia DR3 se scaricato con `scripts/gaia_scarica.py`) sono divisi da `scripts/build_star_tiles.py` in un **octree ordinato per luminosità**: ogni tassello ATBL conserva le stelle più luminose della sua cella, i figli quelle più deboli. Il browser apre un tassello solo se la sua stella più brillante può superare la magnitudine limite vista dalla camera (come Gaia Sky e OpenSpace). I dati descrittivi (nomi, classe spettrale, cataloghi) stanno in `info.sqlite` e si leggono solo quando si clicca una stella.

**Colore**: dall'indice B−V la temperatura (Ballesteros 2012), da questa il colore del corpo nero, calcolato nello shader. Il colore è in sRGB e viene convertito in luce lineare; la luminosità percepita è uguagliata, così una stella rossa e una bianca della stessa magnitudine sembrano brillanti uguali. Le stelle senza misura di colore hanno il valore segnaposto 0,65 (quello del Sole), escluso dai calcoli.

**Tipo** (`frontend/src/core/stellar.ts`): se il catalogo ha la classe spettrale (es. "M2Ib") se ne ricavano temperatura e classe di luminosità; altrimenti si stima dalla posizione nel diagramma H-R rispetto alla sequenza principale (tabella di Mamajek). Luminosità totale con la correzione bolometrica (Flower/Torres, e Pecaut & Mamajek sotto i 4000 K), raggio con la legge di Stefan-Boltzmann. Il server calcola una volta l'istogramma colore × magnitudine del catalogo (`/api/stars/{cat}/hr.json`) per disegnare il diagramma H-R nella scheda.

## Ombre ed eclissi

Lo shader dei corpi riceve, per ogni corpo visibile, fino a 4 "occultatori" scelti sulla CPU (il pianeta attorno a cui gira, le lune sorelle, le proprie lune) fra quelli abbastanza vicini alla linea corpo-Sole. Per ogni punto della superficie calcola quanta parte del **disco del Sole** è coperta (area di intersezione di due cerchi): ombra, penombra, eclissi anulari e totali escono senza casi particolari. La Terra lascia passare nella sua ombra una luce rossa (la Luna color rame). Gli anelli di Saturno proiettano sul pianeta la loro trasparenza (stessa texture). Le posizioni sono relative al centro del corpo, quindi la precisione è piena anche lontano dall'origine.

## Texture

Pianeti, Sole e Luna: Solar System Scope, scaricate al primo uso. Lune, pianeti nani e asteroidi: mappe del progetto Celestia incluse nel progetto (`data/assets/textures`, generate da `scripts/prepara_texture_lune.py` a partire da una versione fissa del repository). `manifest.json` conserva per ognuna autori, licenza, un **guadagno** per i corpi scurissimi e l'indicazione delle mappe in bianco e nero, che il programma tinge con il colore del catalogo. Le forme irregolari partono da una sfera a meridiani e paralleli (stesse coordinate di texture dei pianeti) con normali calcolate dalla forma, senza cuciture.

## Cielo profondo

Le foto di nebulose, ammassi e galassie (`data/assets/dso`) sono riproiettate dallo script su un piano tangente al cielo centrato sull'oggetto, nord in alto, unendo i tasselli quando servono. Nel programma diventano un rettangolo rivolto alla camera, grande quanto la foto alla distanza dell'oggetto: dalla direzione del Sole (cioè della Terra) coincidono con il cielo vero. Per Andromeda, gli ammassi, le nebulose e le Nubi di Magellano la foto vale solo entro una ventina di gradi da quella direzione; altrove si vede il modello 3D (disco a spirale, ammasso di Plummer, nuvola ricavata dalla foto). Per gli ammassi aperti e globulari il modello prende il posto della foto anche avvicinandosi. Le stelle S hanno elementi orbitali "sul cielo" (Thiele-Innes, `ephem/skyorbit.ts`) attorno a Sgr A*.

### Dentro la Galassia

- **Nebulose in 3D** (`render/nebulacloud.ts`): dalla foto si estrae una nuvola di 12.000 sbuffi (punti con un alone
  gaussiano) disposti sul piano della foto con uno spessore lungo la linea di vista; la luce totale è quella della
  foto. Dalla direzione della Terra si vede la foto, altrove la nuvola (`wPhoto` in `bodyvisual.ts`).
- **Galassie vicine in 3D** (Nubi di Magellano, campo `cloud` del catalogo): stessa nuvola delle nebulose, ma ogni
  sbuffo sta sul disco inclinato (inclinazione e linea dei nodi misurate con le Cefeidi; il lato vicino è a
  "linea dei nodi − 90°") più uno spessore lungo la linea di vista, così dalla Terra ricade nel punto della foto da
  cui viene. `mask` esclude oggetti in primo piano (47 Tucanae, NGC 362), sbuffi più fini (`grain`). Se dalla camera
  la galassia sta dietro il disco della Via Lattea (`crossesGalacticDisk` in `core/galactic.ts`) si disegna prima
  delle polveri del modello, che la oscurano: è l'indizio che fa capire chi sta davanti.
- **Ammassi aperti** (`render/opencluster.ts`, campo `open_cluster`): Pleiadi e Iadi stella per stella, profilo di
  Plummer tagliato al raggio mareale, popolazione per età (magnitudine assoluta e B−V); ogni stella si disegna come
  quelle del catalogo (stesso colore, `STAR_COLOR_GLSL` in `render/stars.ts`, stesso limite di magnitudine). Dalla
  direzione della Terra e da lontano valgono foto e stelle vere. Le stelle troppo deboli vanno spostate fuori dallo
  schermo: `gl_PointSize = 0` non basta (la scheda video lo porta a 1 pixel).
- **Ammassi globulari** (`render/globular.ts`): da fuori tutte le stelle hanno lo stesso alone sullo schermo
  (fino a 14 px) e la luce totale cala con il quadrato della distanza; entrando (fra 4 e 1,5 raggi di metà luce)
  l'alone passa a dipendere dalla distanza vera di ogni stella. Le distanze si misurano nella scala del gruppo
  (spazio rimpicciolito oltre 10¹⁰ km).
- **Luce diffusa** (`GalaxySky` in `render/galaxy.ts`): una sfera attorno alla camera (raggio 1000 km, senza
  profondità) su cui ogni pixel integra in 44 passi emissione e assorbimento del modello: disco sottile e spesso,
  stelle giovani lungo i bracci (mappa 256×256 dal worker), barra e bulge, polveri. Passi geometrici se la camera è
  dentro, uguali se è fuori. Dentro il disco le nuvolette del modello a particelle si attenuano (`insideDisk`).
- **Galassia da lontanissimo** (`GalaxyLayer` in `render/galaxy.ts`): l'ordine delle particelle è mescolato nel
  worker, così le prime n sono un campione a caso; quando il disco è piccolo sullo schermo se ne disegnano circa 20
  per pixel del disco, ognuna con la luce di N/n (luce totale invariata). La distanza nello shader si calcola senza
  elevare al quadrato i km (`big * length(mv / big)`): oltre ~600 kpc il quadrato supera il massimo di un float32.
- **Stelle procedurali** (`render/procstars.ts`): celle attorno alla camera, in coordinate del modello (kpc,
  origine in Sgr A*); il numero di stelle per cella segue la densità del modello, posizioni, magnitudini e colori
  vengono da un generatore con seme fisso per cella. Due gusci (50 pc e 400 pc), ognuno rigenerato quando ci si
  sposta di una sua cella, al massimo uno per fotogramma. Spariscono entro ~300 pc dal Sole (stelle vere).

## Prestazioni

Le linee delle orbite si ricalcolano solo se visibili e si ricostruiscono solo quando l'orbita o la posizione lungo l'orbita cambiano di mezzo segmento; il limite di fotogrammi al secondo (60 di serie) evita che un monitor a 144 Hz faccia lavorare la scheda video più del necessario. Texture e foto si caricano solo quando l'oggetto diventa visibile.

## Eventi

`frontend/src/events/astroevents.ts` calcola nel browser, con Astronomy Engine (MIT), eclissi, opposizioni, elongazioni, transiti, fasi, stagioni, apsidi e i massimi degli sciami di meteore (dalla longitudine del Sole, tabella IMO). La libreria si carica solo all'apertura del pannello. I passaggi ravvicinati arrivano dal CNEOS attraverso il server (`/api/events/approaches`, cache di 12 ore). "Vai" porta l'orologio della simulazione all'evento e inquadra il corpo giusto.

## Identificativi

| Prefisso | Significato | Esempio |
|---|---|---|
| `ssb` | baricentro del Sistema Solare | |
| `naif:` | codice NAIF/SPICE | `naif:399` Terra, `naif:-31` Voyager 1 |
| `sb:` | designazione primaria JPL SBDB | `sb:433` Eros, `sb:1P` Halley |
| `norad:` | catalogo NORAD dei satelliti | `norad:25544` ISS |
| `star:<catalogo>:<id>` | stella dei cataloghi a tasselli (catalogo HYG: id HYG; catalogo Gaia: `source_id`, e id HYG col segno meno per le stelle prese da HYG) | `star:hyg:27919` Betelgeuse |

## Principi

- **Dati separati dal codice**: catalogo in JSON, schede in Markdown, preferenze nel browser.
- **Mai fingere precisione**: ogni posizione dichiara la propria fonte.
- **Cortesia verso i servizi pubblici**: concorrenza limitata per ogni sito, cache con scadenze ragionevoli, nessuna richiesta inutile all'avvio (le texture e le traiettorie si scaricano solo quando servono).
