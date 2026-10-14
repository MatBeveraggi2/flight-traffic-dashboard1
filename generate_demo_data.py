"""Génère un jeu de données FICTIF de vols commerciaux pour une journée donnée.

Usage :
    python src/generate_demo_data.py                  # 2026-10-13, graine par défaut
    python src/generate_demo_data.py --day 2026-10-13 --seed 7

Le résultat a exactement le schéma attendu par compute_metrics.py. Pour passer sur de
vraies données, il suffit de produire un CSV avec les mêmes colonnes (voir le README).

Scénario injecté pour que le dashboard raconte quelque chose : des orages sur Chicago
(ORD) en fin d'après-midi, heure locale. Hausse des retards et des annulations au départ.
"""

import argparse
import math
from pathlib import Path

import numpy as np
import pandas as pd

from reference import AIRLINES, AIRPORTS

ROOT = Path(__file__).resolve().parent.parent
PAIRS_PER_SIZE = 35  # ~11 800 vols avec les tailles de reference.py

# Profil horaire des départs, en heure locale (creux la nuit, deux vagues)
PROFILE = np.array(
    [0.4, 0.3, 0.2, 0.2, 0.5, 2.5, 6, 7.5, 7, 6, 5.5, 5, 5, 5, 5.5, 6, 6.5, 7, 7, 6.5, 5.5, 4, 2.5, 1.2]
)

# Ajustement de la probabilité de retard selon l'aéroport de départ
AIRPORT_ADJ = {
    "EWR": 0.10, "JFK": 0.07, "ORD": 0.07, "LHR": 0.06, "LGW": 0.05, "ATL": 0.04,
    "FRA": 0.04, "AMS": 0.04, "CDG": 0.04, "IST": 0.03, "MIA": 0.03, "LAX": 0.02,
    "HND": -0.05, "SIN": -0.04, "ICN": -0.04, "ZRH": -0.03, "DOH": -0.03, "DXB": -0.02,
    "VIE": -0.02, "HEL": -0.02,
}


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def build_legs(rng, ap, codes, dist):
    """Tire des paires aéroport-hub / destination, puis crée l'aller et le retour."""
    legs = []
    for al in AIRLINES:
        hubs = list(al["hubs"])
        hub_p = np.array(list(al["hubs"].values()), float)
        hub_p /= hub_p.sum()
        airline_adj = rng.uniform(-0.05, 0.07)
        dest_p = {}
        for h in hubs:
            w = np.array([
                ap[c]["weight"] ** 1.2 / (1 + dist(h, c) / 2500)
                if c != h and ap[c]["region"] in al["regions"] else 0.0
                for c in codes
            ])
            dest_p[h] = w / w.sum()
        n_pairs = int(round(al["size"] * PAIRS_PER_SIZE))
        hub_draw = rng.choice(len(hubs), size=n_pairs, p=hub_p)
        seen, base_num = {}, {}
        for k in range(n_pairs):
            h = hubs[hub_draw[k]]
            d = codes[rng.choice(len(codes), p=dest_p[h])]
            key = tuple(sorted((h, d)))
            n = seen.get(key, 0)
            seen[key] = n + 1
            base = base_num.setdefault(key, int(rng.integers(100, 880)))
            for direction, (o, t) in enumerate(((h, d), (d, h))):
                legs.append((al["code"], al["name"], airline_adj, base + 2 * n + direction, o, t))
    return legs


def generate(day: str, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ap = {a[0]: dict(city=a[1], country=a[2], region=a[3], lat=a[4], lon=a[5], tz=a[6], weight=a[7]) for a in AIRPORTS}
    codes = list(ap)
    cache = {}

    def dist(a, b):
        if (a, b) not in cache:
            cache[(a, b)] = haversine_km(ap[a]["lat"], ap[a]["lon"], ap[b]["lat"], ap[b]["lon"])
        return cache[(a, b)]

    df = pd.DataFrame(
        build_legs(rng, ap, codes, dist),
        columns=["airline_code", "airline_name", "airline_adj", "flight_number", "origin", "destination"],
    )
    n = len(df)
    tz = df["origin"].map(lambda c: ap[c]["tz"]).to_numpy()
    df["distance_km"] = [round(dist(o, d)) for o, d in zip(df["origin"], df["destination"])]

    # Heure de départ programmée (UTC) : le profil local est décalé par le fuseau de l'aéroport
    dep_hour = np.zeros(n, dtype=int)
    for tzv in np.unique(tz):
        idx = np.where(tz == tzv)[0]
        w = np.array([PROFILE[(h + int(round(tzv))) % 24] for h in range(24)])
        dep_hour[idx] = rng.choice(24, size=len(idx), p=w / w.sum())
    dep_min = dep_hour * 60 + rng.integers(0, 12, size=n) * 5
    day_start = pd.Timestamp(day, tz="UTC")
    sched_dep = day_start + pd.to_timedelta(dep_min, unit="m")
    block = np.maximum(55, (df["distance_km"].to_numpy() / 780 * 60 + 35)).round(-0).astype(int)
    block = (np.round(block / 5) * 5).astype(int)
    sched_arr = sched_dep + pd.to_timedelta(block, unit="m")
    arr_hour = sched_arr.hour.to_numpy()

    # Retards : probabilité de base + effets aéroport, compagnie, heure locale
    local_hour = (dep_hour + tz) % 24
    adj_o = df["origin"].map(AIRPORT_ADJ).fillna(0).to_numpy()
    adj_d = df["destination"].map(AIRPORT_ADJ).fillna(0).to_numpy()
    p = 0.17 + adj_o + 0.5 * adj_d + df["airline_adj"].to_numpy() + 0.10 * np.clip((local_hour - 6) / 14, 0, 1)
    storm = (df["origin"].to_numpy() == "ORD") & (dep_hour >= 19) & (dep_hour <= 22)
    p = np.where(storm, 0.55, p)
    p = np.clip(p, 0.03, 0.8)

    delayed = rng.random(n) < p
    dep_delay = np.where(delayed, 15 + rng.lognormal(2.9, 0.8, n), np.clip(rng.normal(-2, 5, n), -15, 14))
    dep_delay = dep_delay + np.where(storm & delayed, rng.integers(20, 90, n), 0)
    dep_delay = np.clip(np.round(dep_delay), -15, 420).astype(int)

    arr_delay = dep_delay + np.round(np.where(dep_delay >= 15, rng.normal(-5, 8, n), rng.normal(0, 7, n)))
    ground_stop = (df["destination"].to_numpy() == "ORD") & (arr_hour >= 19) & (rng.random(n) < 0.5)
    arr_delay = arr_delay + np.where(ground_stop, rng.integers(15, 70, n), 0)
    arr_delay = np.clip(arr_delay, -30, 480).astype(int)

    cancelled = rng.random(n) < np.where(storm, 0.07, 0.012)
    diverted = ~cancelled & (rng.random(n) < 0.0025)
    arr_delay = np.where(diverted, rng.integers(40, 150, n), arr_delay)

    status = np.where(cancelled, "cancelled", np.where(diverted, "diverted", "landed"))
    actual_dep = sched_dep + pd.to_timedelta(dep_delay, unit="m")
    actual_arr = sched_arr + pd.to_timedelta(arr_delay, unit="m")

    iso = lambda s: s.strftime("%Y-%m-%dT%H:%M:%SZ")
    out = pd.DataFrame({
        "flight_id": df["airline_code"] + df["flight_number"].astype(str) + "-" + df["origin"] + "-" + df["destination"] + "-" + day,
        "airline_code": df["airline_code"],
        "airline_name": df["airline_name"],
        "flight_number": df["airline_code"] + df["flight_number"].astype(str),
        "origin": df["origin"],
        "destination": df["destination"],
        "distance_km": df["distance_km"],
        "scheduled_dep_utc": iso(sched_dep),
        "actual_dep_utc": np.where(cancelled, "", iso(actual_dep)),
        "scheduled_arr_utc": iso(sched_arr),
        "actual_arr_utc": np.where(cancelled, "", iso(actual_arr)),
        "dep_delay_min": pd.array(np.where(cancelled, pd.NA, dep_delay), dtype="Int64"),
        "arr_delay_min": pd.array(np.where(cancelled, pd.NA, arr_delay), dtype="Int64"),
        "status": status,
        "data_source": "demo-synthetic",
    })
    return out.sort_values(["scheduled_dep_utc", "flight_id"]).reset_index(drop=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--day", default="2026-10-13")
    parser.add_argument("--seed", type=int, default=20261013)
    args = parser.parse_args()

    out = generate(args.day, args.seed)
    data_dir = ROOT / "data"
    data_dir.mkdir(exist_ok=True)
    path = data_dir / f"flights_demo_{args.day}.csv"
    out.to_csv(path, index=False)

    pd.DataFrame(AIRPORTS, columns=["iata", "city", "country", "region", "lat", "lon", "utc_offset", "traffic_weight"]).to_csv(
        data_dir / "airports.csv", index=False
    )
    pd.DataFrame([{k: v for k, v in a.items() if k in ("code", "name")} for a in AIRLINES]).to_csv(
        data_dir / "airlines_demo.csv", index=False
    )
    print(f"{len(out)} vols écrits dans {path}")


if __name__ == "__main__":
    main()
