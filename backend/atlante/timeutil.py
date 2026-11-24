"""Conversioni di tempo: data di calendario <-> Giorno Giuliano (JD)."""

from __future__ import annotations

import math
import re
import time

J2000 = 2451545.0
UNIX_EPOCH_JD = 2440587.5
# TDB - UTC: 37 secondi intercalari (dal 2017) + 32.184 s (TT - TAI)
TDB_MINUS_UTC = 69.184

_MONTHS = {m: i + 1 for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}


def jd_from_calendar(y: int, mo: int, d: float) -> float:
    """Algoritmo di Meeus (calendario gregoriano)."""
    if mo <= 2:
        y -= 1
        mo += 12
    a = y // 100
    b = 2 - a + a // 4
    return math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (mo + 1)) + d + b - 1524.5


def jd_now_tdb() -> float:
    return UNIX_EPOCH_JD + (time.time() + TDB_MINUS_UTC) / 86400.0


def jd_from_iso_date(s: str) -> float:
    """'1977-09-05' o '1977-09-05T12:00' (UTC, approssimato a TDB)."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?", s)
    if not m:
        raise ValueError(f"Data non valida: {s}")
    y, mo, d = int(m[1]), int(m[2]), int(m[3])
    hh = int(m[4] or 0)
    mm = int(m[5] or 0)
    return jd_from_calendar(y, mo, d + (hh + mm / 60) / 24) + TDB_MINUS_UTC / 86400.0


def jd_from_horizons_date(s: str) -> float | None:
    """'1977-SEP-05 14:10:50.0000' -> JD."""
    m = re.match(r"(\d{4})-([A-Z]{3})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?", s.strip().upper())
    if not m or m[2] not in _MONTHS:
        return None
    hh = int(m[4] or 0)
    mi = int(m[5] or 0)
    ss = float(m[6] or 0)
    return jd_from_calendar(int(m[1]), _MONTHS[m[2]], int(m[3]) + (hh + mi / 60 + ss / 3600) / 24)
