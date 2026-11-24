"""Formato binario "ATBL" per tabelle numeriche grandi (asteroidi, stelle, ...).

Struttura:
    4 byte  'ATBL'
    uint32  versione (1)
    uint32  lunghezza del blocco JSON (allineato a 8 byte)
    JSON    metadati + elenco colonne {name, dtype, offset, count}
    dati    colonne contigue little-endian, ognuna allineata a 8 byte

È lo stesso formato che useremo per i "tasselli" di stelle della Via Lattea:
il browser lo legge senza conversioni (TypedArray diretti).

Il server usa solo la libreria standard (modulo array); gli script di
preparazione dati possono passare anche array numpy.
"""

from __future__ import annotations

import array
import json
import struct
import sys
from typing import Any

# codici del modulo array -> tipi ATBL (dimensioni fisse su tutte le piattaforme)
_FROM_TYPECODE = {"d": "f8", "f": "f4", "B": "u1", "H": "u2", "h": "i2", "I": "u4", "i": "i4"}
_TO_TYPECODE = {v: k for k, v in _FROM_TYPECODE.items()}


def _column(arr: Any) -> tuple[str, bytes, int]:
    if isinstance(arr, array.array):
        if arr.typecode not in _FROM_TYPECODE:
            raise TypeError(f"Tipo di colonna non gestito: {arr.typecode}")
        a = arr
        if sys.byteorder != "little":
            a = array.array(arr.typecode, arr)
            a.byteswap()
        return _FROM_TYPECODE[arr.typecode], a.tobytes(), len(arr)
    # array numpy (solo negli script)
    dt = arr.dtype
    if dt.byteorder == ">":
        arr = arr.byteswap().view(dt.newbyteorder("<"))
    return arr.dtype.str[1:], arr.tobytes(), int(arr.size)


def pack(meta: dict[str, Any], columns: dict[str, Any]) -> bytes:
    cols_meta = []
    blobs = []
    offset = 0
    for name, arr in columns.items():
        dtype, raw, count = _column(arr)
        pad = (-len(raw)) % 8
        cols_meta.append({"name": name, "dtype": dtype, "offset": offset, "count": count})
        blobs.append(raw + b"\0" * pad)
        offset += len(raw) + pad
    meta = dict(meta)
    meta["columns"] = cols_meta
    js = json.dumps(meta, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    js += b" " * ((-(12 + len(js))) % 8)
    return b"ATBL" + struct.pack("<II", 1, len(js)) + js + b"".join(blobs)


def unpack(data: bytes) -> tuple[dict[str, Any], dict[str, array.array]]:
    assert data[:4] == b"ATBL", "formato non riconosciuto"
    _version, jlen = struct.unpack("<II", data[4:12])
    meta = json.loads(data[12:12 + jlen].decode("utf-8"))
    base = 12 + jlen
    cols = {}
    for c in meta["columns"]:
        a = array.array(_TO_TYPECODE[c["dtype"]])
        start = base + c["offset"]
        a.frombytes(data[start:start + c["count"] * a.itemsize])
        if sys.byteorder != "little":
            a.byteswap()
        cols[c["name"]] = a
    return meta, cols
