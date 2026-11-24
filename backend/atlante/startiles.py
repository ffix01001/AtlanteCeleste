"""Divide un catalogo stellare in "tasselli" (octree) per caricarlo a pezzi.

È la struttura che permette di arrivare ai milioni (e un giorno miliardi) di stelle di Gaia: il
browser non scarica tutto il catalogo, ma solo i tasselli che servono per quello che la camera
sta guardando (come fanno Gaia Sky e OpenSpace).

Come funziona (octree "ordinato per luminosità"):
  - lo spazio attorno al Sole è un grande cubo; ogni cubo si divide in 8 figli;
  - ogni cubo conserva al massimo CAP stelle: le più luminose *in assoluto*
    (magnitudine assoluta) fra quelle che contiene, le altre scendono nei figli;
  - così da lontano bastano i cubi in alto (le stelle più brillanti, visibili
    da molto lontano); avvicinandosi si aprono i figli con le stelle più deboli.

Uscita: <cartella del catalogo>/
  index.json          albero dei tasselli (centro, lato, conteggi, luminosità massima)
  tiles/<id>.atbl     un file binario ATBL per tassello (x, y, z in parsec, ICRS, origine nel Sole)
  names.json          stelle con un nome (per la ricerca), con posizione e tassello
  info.sqlite         i dati descrittivi di ogni stella (consultati su richiesta, per id)

Lo usano scripts/build_star_tiles.py e, dentro il programma, il download di Gaia (gaia_job.py).
Richiede numpy.
"""

from __future__ import annotations

import csv
import glob
import gzip
import json
import math
import sqlite3
from pathlib import Path
from typing import Callable

import numpy as np

from . import binpack
from .config import GENERATED_DIR

CAP = 8192          # stelle per tassello
MAX_DEPTH = 18      # profondità massima (un cubo di 2^18 pc diviso 18 volte = 1 pc)

Progress = Callable[[str], None]


# ----------------------------------------------------------------------------- dati
class Stars:
    """Colonne parallele: x, y, z [pc], absmag, ci (B−V), flags, id (intero) + dati descrittivi.

    I dati descrittivi stanno in `info` (lista di dizionari, per HYG) oppure, per
    cataloghi da milioni di stelle (Gaia), in colonne compatte lette da `info_of`.
    """

    def __init__(self, n: int = 0):
        self.x = np.zeros(n, np.float64)
        self.y = np.zeros(n, np.float64)
        self.z = np.zeros(n, np.float64)
        self.absmag = np.zeros(n, np.float32)
        self.ci = np.zeros(n, np.float32)
        self.flags = np.zeros(n, np.uint8)
        self.ids = np.zeros(n, np.int64)
        self.info: list[dict] = []
        # colonne compatte (Gaia)
        self.g = None
        self.plx = None
        self.hip = None
        self.extra: dict[int, dict] = {}  # nomi e designazioni prestati da HYG, per indice
        self.parts: tuple["Stars", "Stars"] | None = None  # insieme unito: i dati restano nelle parti

    def __len__(self) -> int:
        return len(self.x)

    def info_of(self, i: int) -> dict:
        if self.parts is not None:
            a, b = self.parts
            return a.info_of(i) if i < len(a) else b.info_of(i - len(a))
        if self.info:
            return self.info[i]
        d = {"gaia_dr3": str(int(self.ids[i])), "mag_g": round(float(self.g[i]), 3),
             "plx_mas": round(float(self.plx[i]), 4), "dist_pc": round(1000.0 / float(self.plx[i]), 3)}
        if self.hip[i] > 0:
            d["hip"] = int(self.hip[i])
        d.update(self.extra.get(i, {}))
        return d


def load_hyg(gen: Path = GENERATED_DIR) -> Stars:
    meta_cols, cols = binpack.unpack((gen / "stars_hyg.atbl").read_bytes())
    meta = json.loads((gen / "stars_hyg_meta.json").read_text(encoding="utf-8"))
    fields = meta["fields"]
    rows = meta["rows"]
    n = len(rows)
    s = Stars(n)
    s.x[:] = np.frombuffer(cols["x"], np.float32)
    s.y[:] = np.frombuffer(cols["y"], np.float32)
    s.z[:] = np.frombuffer(cols["z"], np.float32)
    s.absmag[:] = np.frombuffer(cols["absmag"], np.float32)
    s.ci[:] = np.frombuffer(cols["ci"], np.float32)
    s.flags[:] = np.frombuffer(cols["flags"], np.uint8)
    for i, r in enumerate(rows):
        d = dict(zip(fields, r))
        s.ids[i] = int(d["hyg_id"])
        d["catalog"] = "HYG v4.1"
        s.info.append(d)
    return s


def bp_rp_to_bv(bp_rp: float) -> float:
    """Indice di colore Gaia (BP−RP) -> B−V approssimato, solo per il colore a schermo."""
    if not math.isfinite(bp_rp):
        return 0.65
    if bp_rp < 1.2:
        return 0.8 * bp_rp - 0.01
    return 0.95 + 0.5 * (bp_rp - 1.2)


def load_gaia(folder: Path, hyg: Stars | None, progress: Progress = print) -> Stars:
    """CSV di gaia_scarica.py: source_id, ra, dec, parallax, parallax_error, phot_g_mean_mag, bp_rp, hip."""
    files = sorted(glob.glob(str(folder / "*.csv.gz"))) + sorted(glob.glob(str(folder / "*.csv")))
    if not files:
        raise FileNotFoundError(f"Nessun file CSV in {folder}: prima vanno scaricate le stelle di Gaia")
    sid, ra, dec, plx, gmag, bprp, hip = [], [], [], [], [], [], []
    for f in files:
        op = gzip.open if f.endswith(".gz") else open
        with op(f, "rt", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                try:
                    p = float(row["parallax"])
                    g = float(row["phot_g_mean_mag"])
                    r = float(row["ra"])
                    d = float(row["dec"])
                    s_id = int(row["source_id"])
                except (TypeError, ValueError, KeyError):
                    continue
                if p <= 0:
                    continue
                sid.append(s_id); ra.append(r); dec.append(d); plx.append(p); gmag.append(g)
                try:
                    bprp.append(float(row.get("bp_rp") or "nan"))
                except ValueError:
                    bprp.append(float("nan"))
                h = (row.get("hip") or "").strip()
                try:
                    hip.append(int(float(h)) if h else 0)
                except ValueError:
                    hip.append(0)
        progress(f"letto {Path(f).name}: {len(sid)} stelle finora")
    n = len(sid)
    s = Stars(n)
    ra_r = np.radians(np.asarray(ra))
    dec_r = np.radians(np.asarray(dec))
    plx_a = np.asarray(plx)
    dist = 1000.0 / plx_a
    s.x[:] = dist * np.cos(dec_r) * np.cos(ra_r)
    s.y[:] = dist * np.cos(dec_r) * np.sin(ra_r)
    s.z[:] = dist * np.sin(dec_r)
    g_a = np.asarray(gmag)
    s.absmag[:] = g_a + 5 * np.log10(plx_a / 100.0)
    s.ci[:] = [bp_rp_to_bv(v) for v in bprp]
    s.ids[:] = sid
    s.g = g_a.astype(np.float32)
    s.plx = plx_a.astype(np.float32)
    s.hip = np.asarray(hip, np.int32)
    if hyg is None:
        return s
    # stelle HYG: si tengono quelle che Gaia non ha (le più luminose saturano i suoi rivelatori)
    # e si prestano nomi e designazioni alle stelle Gaia con lo stesso numero Hipparcos
    hip_in_gaia = set(int(h) for h in s.hip if h > 0)
    by_hip = {d["hip"]: d for d in hyg.info if d.get("hip")}
    for i in np.nonzero(s.hip > 0)[0]:
        h = by_hip.get(int(s.hip[i]))
        if h:
            s.extra[int(i)] = {k: h[k] for k in ("proper", "name_it", "bayer", "flamsteed", "con", "spect", "hd", "hr", "gliese")
                               if h.get(k) is not None}
    keep = [i for i, d in enumerate(hyg.info) if not (d.get("hip") and d["hip"] in hip_in_gaia)]
    extra = Stars(len(keep))
    for name in ("x", "y", "z", "absmag", "ci", "flags"):
        getattr(extra, name)[:] = getattr(hyg, name)[keep]
    # id HYG in uno spazio separato dagli id Gaia (positivi): segno negativo
    extra.ids[:] = -hyg.ids[keep]
    extra.info = [hyg.info[i] for i in keep]
    progress(f"{len(keep)} stelle aggiunte da HYG (assenti o troppo luminose per Gaia)")
    return concat(s, extra)


def concat(a: Stars, b: Stars) -> Stars:
    """Unisce due insiemi (i dati descrittivi restano dove sono: si leggono con info_of)."""
    s = Stars(len(a) + len(b))
    for name in ("x", "y", "z", "absmag", "ci", "flags", "ids"):
        getattr(s, name)[:] = np.concatenate([getattr(a, name), getattr(b, name)])
    s.parts = (a, b)
    return s


# ----------------------------------------------------------------------------- octree
class Node:
    __slots__ = ("id", "cx", "cy", "cz", "h", "idx", "children", "min_abs", "sub_min_abs", "depth")

    def __init__(self, nid: str, cx: float, cy: float, cz: float, h: float, depth: int):
        self.id, self.cx, self.cy, self.cz, self.h, self.depth = nid, cx, cy, cz, h, depth
        self.idx: np.ndarray = np.zeros(0, np.int64)
        self.children: list[Node] = []
        self.min_abs = 99.0       # stella più brillante del tassello
        self.sub_min_abs = 99.0   # stella più brillante di tutto il ramo (tassello + discendenti)


def build_octree(s: Stars, cap: int = CAP) -> Node:
    ext = float(max(np.abs(s.x).max(), np.abs(s.y).max(), np.abs(s.z).max(), 1.0))
    h0 = 2.0 ** math.ceil(math.log2(ext * 1.001))
    root = Node("r", 0.0, 0.0, 0.0, h0, 0)
    order = np.argsort(s.absmag, kind="stable")  # le più brillanti per prime
    _fill(root, order, s, cap)
    return root


def _fill(node: Node, idx: np.ndarray, s: Stars, cap: int) -> None:
    # idx è già ordinato per luminosità decrescente
    if len(idx) == 0:
        return
    node.sub_min_abs = float(s.absmag[idx[0]])
    if len(idx) <= cap or node.depth >= MAX_DEPTH:
        node.idx = idx
        node.min_abs = node.sub_min_abs
        return
    node.idx = idx[:cap]
    node.min_abs = node.sub_min_abs
    rest = idx[cap:]
    ox = (s.x[rest] >= node.cx).astype(np.int8)
    oy = (s.y[rest] >= node.cy).astype(np.int8)
    oz = (s.z[rest] >= node.cz).astype(np.int8)
    octant = ox + 2 * oy + 4 * oz
    h2 = node.h / 2
    for k in range(8):
        sub = rest[octant == k]  # l'ordine per luminosità si conserva
        if len(sub) == 0:
            continue
        cx = node.cx + (h2 if k & 1 else -h2)
        cy = node.cy + (h2 if k & 2 else -h2)
        cz = node.cz + (h2 if k & 4 else -h2)
        child = Node(node.id + str(k), cx, cy, cz, h2, node.depth + 1)
        node.children.append(child)
        _fill(child, sub, s, cap)


def walk(node: Node):
    yield node
    for c in node.children:
        yield from walk(c)


# ----------------------------------------------------------------------------- scrittura
def write(s: Stars, root: Node, out: Path, catalog: dict, progress: Progress = print) -> None:
    # i tasselli vengono sovrascritti; eventuali file di una generazione precedente
    # che non compaiono più nell'indice restano lì ma non vengono mai letti
    (out / "tiles").mkdir(parents=True, exist_ok=True)
    nodes = []
    names = []
    tile_of = {}
    for node in walk(root):
        idx = node.idx
        cols = {
            "x": s.x[idx].astype(np.float32),
            "y": s.y[idx].astype(np.float32),
            "z": s.z[idx].astype(np.float32),
            "absmag": s.absmag[idx].astype(np.float32),
            "ci": s.ci[idx].astype(np.float32),
            "flags": s.flags[idx].astype(np.uint8),
            # id come coppia di uint32 (i numeri Gaia non stanno in 32 bit)
            "id_hi": ((s.ids[idx] >> 32) & 0xFFFFFFFF).astype(np.uint32),
            "id_lo": (s.ids[idx] & 0xFFFFFFFF).astype(np.uint32),
        }
        (out / "tiles" / f"{node.id}.atbl").write_bytes(
            binpack.pack({"tile": node.id, "count": int(len(idx))}, cols))
        nodes.append({
            "id": node.id, "c": [node.cx, node.cy, node.cz], "h": node.h, "n": int(len(idx)),
            "m": round(node.min_abs, 3), "sm": round(node.sub_min_abs, 3),
            "k": [c.id for c in node.children],
        })
        for i in idx:
            tile_of[int(i)] = node.id
    db_path = out / "info.sqlite"
    db_tmp = out / "info.sqlite.tmp"
    if db_tmp.exists():
        db_tmp.unlink()  # residuo di una generazione interrotta (file temporaneo di questo script)
    db = sqlite3.connect(db_tmp)
    db.execute("CREATE TABLE stars (id TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID")
    batch = []
    for i in range(len(s)):
        d = s.info_of(i)
        sid = int(s.ids[i])
        # record compatto: niente campi vuoti, il catalogo è scritto una volta sola nell'indice
        rec = {k: v for k, v in d.items() if v is not None and v is not False and k not in ("catalog", "hyg_id")}
        if isinstance(rec.get("lum"), float):
            rec["lum"] = float(f"{rec['lum']:.4g}")
        rec["x"], rec["y"], rec["z"] = round(float(s.x[i]), 5), round(float(s.y[i]), 5), round(float(s.z[i]), 5)
        rec["absmag"] = round(float(s.absmag[i]), 3)
        batch.append((str(sid), json.dumps(rec, ensure_ascii=False, separators=(",", ":"))))
        if len(batch) >= 50000:
            db.executemany("INSERT OR REPLACE INTO stars VALUES (?, ?)", batch)
            batch.clear()
            progress(f"schede delle stelle: {i + 1} di {len(s)}")
        nm = d.get("name_it") or d.get("proper")
        if nm:
            names.append({"id": str(sid), "name": nm, "p": [rec["x"], rec["y"], rec["z"]],
                          "m": rec["absmag"], "t": tile_of.get(i)})
    db.executemany("INSERT OR REPLACE INTO stars VALUES (?, ?)", batch)
    db.commit()
    db.close()
    db_tmp.replace(db_path)  # sostituzione atomica del file prodotto in precedenza
    index = dict(catalog)
    index.update({"count": len(s), "cap": CAP, "frame": "ICRS, origine nel Sole, parsec", "nodes": nodes})
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "names.json").write_text(json.dumps(names, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    depth = max(n.depth for n in walk(root))
    progress(f"{len(s)} stelle in {len(nodes)} tasselli (profondità {depth}) -> {out}")
