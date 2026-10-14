"""Calcule les indicateurs du dashboard à partir d'un CSV de vols.

Usage :
    python src/compute_metrics.py data/flights_demo_2026-10-13.csv

Schéma attendu (une ligne par vol programmé) :
    flight_id, airline_code, airline_name, flight_number, origin, destination, distance_km,
    scheduled_dep_utc, actual_dep_utc, scheduled_arr_utc, actual_arr_utc,
    dep_delay_min, arr_delay_min, status (landed | cancelled | diverted), data_source

Définitions : un vol est « en retard » si son retard est d'au moins 15 minutes. Les vols
annulés sont comptés dans les volumes mais exclus des retards.
"""

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DELAY_THRESHOLD = 15  # minutes


def load(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype={"actual_dep_utc": "string", "actual_arr_utc": "string"})
    df["operated"] = df["status"] != "cancelled"
    df["arr_late"] = df["operated"] & (df["arr_delay_min"] >= DELAY_THRESHOLD)
    df["dep_late"] = df["operated"] & (df["dep_delay_min"] >= DELAY_THRESHOLD)
    df["dep_hour_utc"] = pd.to_datetime(df["scheduled_dep_utc"]).dt.hour
    df["route"] = df.apply(lambda r: " ↔ ".join(sorted((r["origin"], r["destination"]))), axis=1)
    return df


def r(x, n=1):
    return None if pd.isna(x) else round(float(x), n)


def compute(df: pd.DataFrame, airports: pd.DataFrame) -> dict:
    op = df[df["operated"]]
    city = airports.set_index("iata")["city"].to_dict()

    kpis = {
        "flights": int(len(df)),
        "operated": int(len(op)),
        "cancelled": int((~df["operated"]).sum()),
        "diverted": int((df["status"] == "diverted").sum()),
        "airports": int(pd.concat([df["origin"], df["destination"]]).nunique()),
        "airlines": int(df["airline_code"].nunique()),
        "routes": int(df["route"].nunique()),
        "pct_arr_delayed": r(op["arr_late"].mean() * 100),
        "avg_arr_delay_of_delayed": r(op.loc[op["arr_late"], "arr_delay_min"].mean()),
        "median_arr_delay": r(op["arr_delay_min"].median()),
        "total_delay_hours": r(op.loc[op["arr_delay_min"] > 0, "arr_delay_min"].sum() / 60, 0),
    }

    movements = pd.concat([
        df.groupby("origin").size().rename("departures"),
        df.groupby("destination").size().rename("arrivals"),
    ], axis=1).fillna(0).astype(int)
    movements["movements"] = movements["departures"] + movements["arrivals"]
    movements = movements.sort_index().sort_values("movements", ascending=False, kind="stable")
    top_airports = [
        {"iata": i, "city": city.get(i, i), **{k: int(v) for k, v in row.items()}}
        for i, row in movements.head(15).iterrows()
    ]

    g = df.groupby(["airline_code", "airline_name"])
    airlines = pd.DataFrame({
        "flights": g.size(),
        "cancelled": g["operated"].apply(lambda s: int((~s).sum())),
        "pct_delayed": g["arr_late"].sum() / g["operated"].sum() * 100,
        "avg_arr_delay": df[df["operated"]].groupby(["airline_code", "airline_name"])["arr_delay_min"].mean(),
    }).reset_index().sort_values(["flights", "airline_code"], ascending=[False, True])
    top_airlines = [
        {"code": x.airline_code, "name": x.airline_name, "flights": int(x.flights), "cancelled": int(x.cancelled),
         "pct_delayed": r(x.pct_delayed), "avg_arr_delay": r(x.avg_arr_delay)}
        for x in airlines.itertuples()
    ]

    gr = df.groupby("route")
    routes = pd.DataFrame({
        "flights": gr.size(),
        "distance_km": gr["distance_km"].first(),
        "pct_delayed": gr["arr_late"].sum() / gr["operated"].sum() * 100,
        "airlines": gr["airline_code"].nunique(),
    }).reset_index().sort_values(["flights", "route"], ascending=[False, True])
    top_routes = [
        {"route": x.route, "flights": int(x.flights), "distance_km": int(x.distance_km),
         "airlines": int(x.airlines), "pct_delayed": r(x.pct_delayed)}
        for x in routes.head(15).itertuples()
    ]

    gh = op.groupby("dep_hour_utc")
    by_hour = pd.DataFrame({
        "departures": df.groupby("dep_hour_utc").size(),
        "pct_dep_delayed": gh["dep_late"].mean() * 100,
        "avg_dep_delay": gh["dep_delay_min"].mean(),
    }).reindex(range(24)).fillna(0).reset_index()
    by_hour = [
        {"hour_utc": int(x.dep_hour_utc), "departures": int(x.departures),
         "pct_dep_delayed": r(x.pct_dep_delayed), "avg_dep_delay": r(x.avg_dep_delay)}
        for x in by_hour.itertuples()
    ]

    bins = [-10_000, 0, 14, 29, 59, 119, 10_000]
    labels = ["À l'heure ou en avance", "1 à 14 min", "15 à 29 min", "30 à 59 min", "1 h à 2 h", "2 h et plus"]
    dist = pd.cut(op["arr_delay_min"], bins=bins, labels=labels).value_counts().reindex(labels)
    distribution = [{"bucket": k, "flights": int(v)} for k, v in dist.items()]

    go = op.groupby("origin")
    ap = pd.DataFrame({
        "departures": go.size(),
        "pct_dep_delayed": go["dep_late"].mean() * 100,
        "avg_dep_delay": go["dep_delay_min"].mean(),
    })
    ap = ap[ap["departures"] >= 150].sort_index().sort_values("pct_dep_delayed", ascending=False, kind="stable")
    worst_airports = [
        {"iata": i, "city": city.get(i, i), "departures": int(x.departures),
         "pct_dep_delayed": r(x.pct_dep_delayed), "avg_dep_delay": r(x.avg_dep_delay)}
        for i, x in ap.head(10).iterrows()
    ]

    rt = op.groupby("route")
    wr = pd.DataFrame({
        "flights": rt.size(),
        "pct_delayed": rt["arr_late"].mean() * 100,
        "avg_arr_delay": rt["arr_delay_min"].mean(),
    })
    wr = wr[wr["flights"] >= 20].sort_index().sort_values("pct_delayed", ascending=False, kind="stable")
    worst_routes = [
        {"route": i, "flights": int(x.flights), "pct_delayed": r(x.pct_delayed), "avg_arr_delay": r(x.avg_arr_delay)}
        for i, x in wr.head(10).iterrows()
    ]

    return {
        "meta": {
            "day_utc": str(df["scheduled_dep_utc"].str[:10].mode()[0]),
            "source": str(df["data_source"].iloc[0]),
            "is_demo": bool((df["data_source"] == "demo-synthetic").all()),
            "delay_threshold_min": DELAY_THRESHOLD,
        },
        "kpis": kpis,
        "top_airports": top_airports,
        "top_airlines": top_airlines,
        "top_routes": top_routes,
        "by_hour": by_hour,
        "arrival_delay_distribution": distribution,
        "worst_airports_by_departure_delay": worst_airports,
        "worst_routes_by_delay": worst_routes,
    }


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = Path(sys.argv[1])
    df = load(path)
    airports = pd.read_csv(ROOT / "data" / "airports.csv")
    metrics = compute(df, airports)
    out = path.with_name(path.name.replace("flights_", "metrics_").replace(".csv", ".json"))
    out.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Indicateurs écrits dans {out}")
    print(json.dumps(metrics["kpis"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
