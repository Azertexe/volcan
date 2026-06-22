"""
Volcan — backend Flask Piton de la Fournaise.
Sert le trémor (RMS bande 1.5–5 Hz), les séismes FDSN, le bulletin OVPF,
les webcams, un calculateur de crise et le signal brut décimé.
"""

import math
import re
from datetime import datetime, timedelta, timezone

import numpy as np
import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request
from flask_cors import CORS
from obspy import UTCDateTime
from obspy.clients.fdsn import Client

app = Flask(__name__)
CORS(app)

# ── Constantes communes ────────────────────────────────────────────────
SUMMIT_LAT, SUMMIT_LON = -21.2444, 55.7142

IPGP_EVENT = "https://ws.ipgp.fr/fdsnws/event/1/query"
RENASS_EVENT = "https://api.franceseisme.fr/fdsnws/event/1/query"
BULLETIN_URL = "https://www.ipgp.fr/volcanoweb/reunion/Bulletin_quotidien/bulletin.html"
WEBCAM_BASE = "https://www.ipgp.fr/volcanoweb/reunion/Cameras/"

NETWORK = "PF"
CHANNEL_PRIO = ["HHZ", "BHZ", "EHZ", "SHZ"]
TREMOR_FMIN, TREMOR_FMAX = 1.5, 5.0

client = Client("RESIF")

# Cache mémoire (clé → (timestamp, payload))
_cache: dict = {}
CACHE_TTL_SECONDS = 60


def _cache_get(key, ttl=CACHE_TTL_SECONDS):
    entry = _cache.get(key)
    if entry is None:
        return None
    ts, payload = entry
    if (datetime.now(timezone.utc) - ts).total_seconds() > ttl:
        return None
    return payload


def _cache_set(key, payload):
    _cache[key] = (datetime.now(timezone.utc), payload)


# ── 1) Séismes profonds + sommitaux ────────────────────────────────────
def fetch_events(start_iso, end_iso, maxradius=0.5):
    """Catalogue FDSN OVPF (événements validés). Renvoie une liste de dicts."""
    params = {
        "starttime": start_iso, "endtime": end_iso,
        "latitude": SUMMIT_LAT, "longitude": SUMMIT_LON, "maxradius": maxradius,
        "format": "text", "nodata": "404",
    }
    r = requests.get(IPGP_EVENT, params=params, timeout=30)
    if r.status_code in (204, 404):
        return []
    r.raise_for_status()
    events = []
    for line in r.text.strip().splitlines():
        if not line or line.startswith("#"):
            continue
        p = line.split("|") if "|" in line else line.split(",")
        if len(p) < 6:
            continue
        try:
            events.append({
                "id": p[0], "time": p[1],
                "lat": float(p[2]), "lon": float(p[3]),
                "depth_km": float(p[4]),
                "mag": float(p[5]) if p[5].strip() else None,
            })
        except ValueError:
            continue
    return events


def fetch_events_safe(start_iso, end_iso, maxradius=0.5):
    """Essaie l'IPGP, bascule sur RENASS en cas d'échec réseau."""
    try:
        return fetch_events(start_iso, end_iso, maxradius), "ipgp"
    except Exception:
        try:
            params = {
                "starttime": start_iso, "endtime": end_iso,
                "latitude": SUMMIT_LAT, "longitude": SUMMIT_LON,
                "maxradius": maxradius, "format": "text", "nodata": "404",
                "orderby": "time",
            }
            r = requests.get(RENASS_EVENT, params=params, timeout=30)
            if r.status_code in (204, 404):
                return [], "renass"
            r.raise_for_status()
            events = []
            for line in r.text.strip().splitlines():
                if not line or line.startswith("#"):
                    continue
                p = line.split("|")
                if len(p) < 11:
                    continue
                try:
                    events.append({
                        "id": p[0], "time": p[1],
                        "lat": float(p[2]), "lon": float(p[3]),
                        "depth_km": float(p[4]),
                        "mag": float(p[10]) if p[10].strip() else None,
                    })
                except (ValueError, IndexError):
                    continue
            return events, "renass"
        except Exception:
            return [], "indisponible"


def classify_event(ev):
    dlat = ev["lat"] - SUMMIT_LAT
    dlon = (ev["lon"] - SUMMIT_LON) * math.cos(math.radians(SUMMIT_LAT))
    dist_km = math.hypot(dlat, dlon) * 111.0
    d = ev["depth_km"]
    if dist_km > 10:
        return "local"
    if d <= 0.5 and dist_km <= 3:
        return "sommital"
    if d >= 1.0:
        return "profond"
    return "autre"


@app.route("/seismes")
def seismes():
    """Flux quasi temps réel des séismes localisés, classés. ?hours=24"""
    try:
        hours = int(request.args.get("hours", 24))
    except ValueError:
        hours = 24
    cache_key = f"seismes:{hours}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    fmt = "%Y-%m-%dT%H:%M:%S"
    evs, source = fetch_events_safe(start.strftime(fmt), end.strftime(fmt))
    counts = {"sommital": 0, "profond": 0, "local": 0, "autre": 0}
    for e in evs:
        e["type"] = classify_event(e)
        counts[e["type"]] += 1
    payload = {
        "hours": hours, "total": len(evs),
        "counts": counts, "events": evs, "source": source,
    }
    _cache_set(cache_key, payload)
    return jsonify(payload)


# ── 2) Bulletin quotidien OVPF (éboulements, alertes, comptages) ───────
def _num(text, pattern):
    m = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    return int(m.group(1)) if m else None


def scrape_bulletin():
    r = requests.get(BULLETIN_URL, timeout=20)
    r.raise_for_status()
    r.encoding = r.apparent_encoding
    text = BeautifulSoup(r.text, "html.parser").get_text("\n")

    date_bull = re.search(r"activit[ée] du\s*(\d{2}-\d{2}-\d{4})", text)
    cree_le = re.search(r"cr[ée]{1,2} le\s*(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})", text)
    alerte = re.search(r"Niveau d.?alerte\s*:\s*([^\n]+)", text)

    zones = []
    zm = re.search(
        r"Zone concern[ée]e par les [ée]boulements\s*:(.*?)Nombre de s[ée]ismes",
        text, re.DOTALL | re.IGNORECASE,
    )
    if zm:
        zones = [z.strip("-•* \t") for z in zm.group(1).splitlines() if z.strip("-•* \t")]

    return {
        "date": date_bull.group(1) if date_bull else None,
        "cree_le": cree_le.group(1) if cree_le else None,
        "niveau_alerte": alerte.group(1).strip() if alerte else None,
        "eboulements": {
            "total": _num(text, r"boulements\s+du[^:]*:\s*(\d+)"),
            "zones": zones,
        },
        "vt_sommitaux": _num(text, r"\(VT\)\s*sommitaux[^:]*:\s*(\d+)"),
        "vt_profonds": _num(text, r"\(VT\)\s*profonds[^:]*:\s*(\d+)"),
        "seismes_locaux": _num(text, r"s[ée]ismes\s+locaux[^:]*:\s*(\d+)"),
        "preliminaire": True,
        "source": BULLETIN_URL,
    }


_bulletin_cache = {"data": None, "ts": None}


def get_bulletin_cached():
    now = datetime.now(timezone.utc)
    if (_bulletin_cache["ts"] is None
            or (now - _bulletin_cache["ts"]).total_seconds() > 1800):
        try:
            _bulletin_cache["data"] = scrape_bulletin()
            _bulletin_cache["ts"] = now
        except Exception as e:
            if _bulletin_cache["data"] is None:
                return {"error": str(e), "source": BULLETIN_URL}
    return _bulletin_cache["data"]


@app.route("/bulletin")
def bulletin():
    return jsonify(get_bulletin_cached())


# ── 3) Webcams ─────────────────────────────────────────────────────────
WEBCAMS = [
    {"id": "bory", "label": "Cratère Bory / fond Dolomieu", "file": "CameraBory.jpg"},
    {"id": "doec", "label": "Dolomieu Est", "file": "CameraDOEC.jpg"},
    {"id": "bert", "label": "Piton Bert (Dolomieu + Enclos)", "file": "CameraBERT3.jpg"},
    {"id": "encc", "label": "Enclos Fouqué", "file": "CameraENCC.jpg"},
    {"id": "parc", "label": "Piton Partage", "file": "CameraPARC.jpg"},
    {"id": "basalte", "label": "Piton des Basaltes", "file": "CameraBasalte.jpg"},
    {"id": "cascades", "label": "Piton des Cascades", "file": "CameraCascades.jpg"},
]


@app.route("/webcams")
def webcams():
    return jsonify({"base": WEBCAM_BASE, "cams": WEBCAMS})


# ── 3b) Inventaire des stations PF (depuis RESIF) ──────────────────────
def _zone_for(lat, lon):
    """Zone éditoriale approximative à partir de la position relative au sommet."""
    dlat = lat - SUMMIT_LAT
    dlon = (lon - SUMMIT_LON) * math.cos(math.radians(SUMMIT_LAT))
    dist = math.hypot(dlat, dlon) * 111.0
    if dist <= 3:
        return "Sommet / Enclos"
    if dist > 12:
        return "Hors enclos"
    az = (math.degrees(math.atan2(dlon, dlat)) + 360) % 360
    if az < 45 or az >= 315:
        return "Pentes N"
    if az < 135:
        return "Pentes E / Grand Brûlé"
    if az < 225:
        return "Pentes S"
    return "Pentes O"


@app.route("/stations")
def stations():
    """Liste réelle des stations PF (composante verticale) servie depuis RESIF."""
    cached = _cache_get("stations", ttl=86400)
    if cached is not None:
        return jsonify(cached)
    try:
        inv = client.get_stations(
            network=NETWORK, level="channel", channel="*Z",
            starttime=UTCDateTime() - 86400 * 30,
        )
    except Exception as e:
        return jsonify({"error": str(e), "stations": []}), 502

    seen = {}
    for net in inv:
        for sta in net:
            zchans = sorted({c.code for c in sta.channels
                             if c.code and c.code.endswith("Z")})
            if not zchans or sta.code in seen:
                continue
            name = sta.code
            try:
                if sta.site and sta.site.name:
                    name = sta.site.name
            except Exception:
                pass
            seen[sta.code] = {
                "id": sta.code,
                "name": name,
                "lat": round(float(sta.latitude), 4),
                "lon": round(float(sta.longitude), 4),
                "zone": _zone_for(float(sta.latitude), float(sta.longitude)),
                "channels": zchans,
            }
    out = sorted(seen.values(), key=lambda s: (s["zone"], s["id"]))
    payload = {"network": NETWORK, "count": len(out), "stations": out}
    _cache_set("stations", payload)
    return jsonify(payload)


# ── 4) Calculateur de crise sismique ───────────────────────────────────
@app.route("/crise")
def crise():
    """Détecte un essaim sismique sommital sur une fenêtre courte."""
    try:
        window_h = float(request.args.get("window", 3))
        seuil = int(request.args.get("seuil", 15))
    except ValueError:
        window_h, seuil = 3.0, 15

    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=window_h)
    fmt = "%Y-%m-%dT%H:%M:%S"

    try:
        evs, source = fetch_events_safe(start.strftime(fmt), end.strftime(fmt))
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    vt_som = sum(1 for e in evs if classify_event(e) == "sommital")
    taux_h = vt_som / window_h if window_h else 0

    niveau = None
    try:
        b = get_bulletin_cached()
        if isinstance(b, dict):
            niveau = b.get("niveau_alerte")
    except Exception:
        pass

    return jsonify({
        "fenetre_h": window_h,
        "vt_sommitaux": vt_som,
        "taux_par_heure": round(taux_h, 2),
        "seuil": seuil,
        "crise_probable": vt_som >= seuil,
        "niveau_alerte_ovpf": niveau,
        "source": source,
    })


# ── 5) Trémor + Signal brut ────────────────────────────────────────────
def _get_waveform(station, start, end):
    """Tente plusieurs canaux par ordre de priorité. Renvoie (Trace, canal) ou (None, None)."""
    for channel in CHANNEL_PRIO:
        try:
            st = client.get_waveforms(NETWORK, station, "*", channel, start, end)
            if len(st) == 0:
                continue
            st.merge(method=1, fill_value=0)
            return st[0], channel
        except Exception:
            continue
    return None, None


def tremor_levels(values, baseline=None):
    """values = liste des RMS de trémor déjà calculés."""
    arr = np.asarray([v for v in values if v is not None and v > 0], dtype=float)
    if arr.size == 0:
        return None
    if baseline is None:
        baseline = float(np.percentile(arr, 20))
    seuil_crise = baseline * 3
    seuil_eruption = baseline * 10
    courant = float(arr[-1])
    if courant >= seuil_eruption:
        niveau = "eruption"
    elif courant >= seuil_crise:
        niveau = "crise"
    elif courant >= baseline * 1.5:
        niveau = "vigilance"
    else:
        niveau = "calme"
    return {
        "baseline": round(baseline, 3),
        "seuil_crise": round(seuil_crise, 3),
        "seuil_eruption": round(seuil_eruption, 3),
        "courant": round(courant, 3),
        "niveau": niveau,
    }


@app.route("/tremor")
def tremor():
    """RMS bande 1.5–5 Hz par fenêtres de 30 s. ?station=BOR&hours=6"""
    station = request.args.get("station", "BOR").upper()
    try:
        hours = float(request.args.get("hours", 6))
    except ValueError:
        hours = 6.0

    cache_key = f"tremor:{station}:{hours}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    end = UTCDateTime()
    start = end - hours * 3600
    tr, channel = _get_waveform(station, start, end)
    if tr is None:
        return jsonify({
            "error": "Aucune donnée disponible pour cette station",
            "station": station,
        }), 502

    try:
        tr.detrend("demean")
        tr.filter("bandpass", freqmin=TREMOR_FMIN, freqmax=TREMOR_FMAX,
                  corners=4, zerophase=True)
    except Exception as e:
        return jsonify({"error": f"filtrage: {e}", "station": station}), 502

    sr = float(tr.stats.sampling_rate)
    win_sec = 30.0
    win_n = max(1, int(sr * win_sec))
    data = np.asarray(tr.data, dtype=float)
    n_win = data.size // win_n
    if n_win == 0:
        return jsonify({"error": "trace trop courte", "station": station}), 502

    rms_values = []
    times = []
    t0 = tr.stats.starttime
    for i in range(n_win):
        seg = data[i * win_n:(i + 1) * win_n]
        rms = float(np.sqrt(np.mean(seg * seg))) if seg.size else 0.0
        rms_values.append(round(rms, 3))
        times.append((t0 + (i + 0.5) * win_sec).isoformat())

    payload = {
        "station": station,
        "channel": channel,
        "fmin": TREMOR_FMIN,
        "fmax": TREMOR_FMAX,
        "window_sec": win_sec,
        "hours": hours,
        "t": times,
        "rms": rms_values,
        "unite": "counts",
        "levels": tremor_levels(rms_values),
    }
    _cache_set(cache_key, payload)
    return jsonify(payload)


@app.route("/signal")
def signal():
    """Forme d'onde brute décimée d'une station. ?station=BOR&minutes=10"""
    station = request.args.get("station", "BOR").upper()
    try:
        minutes = float(request.args.get("minutes", 10))
    except ValueError:
        minutes = 10.0

    cache_key = f"signal:{station}:{minutes}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    target_points = 3000
    end = UTCDateTime()
    start = end - minutes * 60
    tr, channel = _get_waveform(station, start, end)
    if tr is None:
        return jsonify({
            "error": "Aucune donnée disponible pour cette station",
            "station": station,
        }), 502

    try:
        factor = max(1, int(tr.stats.npts / target_points))
        if factor > 1:
            tr.decimate(factor, no_filter=False)
        payload = {
            "station": station,
            "channel": channel,
            "start": str(tr.stats.starttime),
            "sampling_rate": float(tr.stats.sampling_rate),
            "t": [round(float(x), 3) for x in tr.times()],
            "v": [round(float(x), 2) for x in tr.data],
            "unite": "counts",
        }
        _cache_set(cache_key, payload)
        return jsonify(payload)
    except Exception as e:
        return jsonify({"error": str(e), "station": station}), 502


# ── Santé ──────────────────────────────────────────────────────────────
@app.route("/")
def root():
    return jsonify({
        "service": "volcan-backend",
        "endpoints": [
            "/tremor?station=BOR&hours=6",
            "/signal?station=BOR&minutes=10",
            "/seismes?hours=24",
            "/bulletin",
            "/webcams",
            "/stations",
            "/crise?window=3&seuil=15",
        ],
    })


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
