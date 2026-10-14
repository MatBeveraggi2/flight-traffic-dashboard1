"""Compare les calculs du dashboard (JS) à un recalcul indépendant avec pandas.

Usage :
    node tests/dump_calcs.js data/flights_demo_2026-10-13.csv /tmp/calcs.json
    python tests/check_calcs.py data/flights_demo_2026-10-13.csv /tmp/calcs.json
"""
import json
import sys

import pandas as pd

csv_path, json_path = sys.argv[1:3]
df = pd.read_csv(csv_path)
calc = json.load(open(json_path, encoding="utf-8"))
df["op"] = df["status"] != "cancelled"
df["route"] = df.apply(lambda r: " ↔ ".join(sorted((r["origin"], r["destination"]))), axis=1)
df["hour"] = pd.to_datetime(df["scheduled_dep_utc"]).dt.hour
day0 = pd.Timestamp(df["scheduled_dep_utc"].iloc[0][:10], tz="UTC")

bad = 0
n_checked = 0


def eq(label, got, want, tol=1e-9):
    global bad, n_checked
    n_checked += 1
    if abs(float(got) - float(want)) > tol:
        bad += 1
        if bad <= 15:
            print(f"ÉCART {label}: dashboard={got} pandas={want}")


codes = ["all"] + sorted(df["airline_code"].unique())
sub = lambda k: df if k == "all" else df[df["airline_code"] == k]

# kpis
rows = {r["airline"]: r for r in calc["kpis_by_airline"]}
assert set(rows) == set(codes), "compagnies manquantes"
for k in codes:
    d, o = sub(k), sub(k)[sub(k)["op"]]
    r = rows[k]
    late = o[o["arr_delay_min"] >= 15]
    eq(f"kpi {k} flights", r["flights"], len(d))
    eq(f"kpi {k} cancelled", r["cancelled"], (~d["op"]).sum())
    eq(f"kpi {k} diverted", r["diverted"], (d["status"] == "diverted").sum())
    eq(f"kpi {k} airports", r["airports"], pd.concat([d["origin"], d["destination"]]).nunique())
    eq(f"kpi {k} routes", r["routes"], d["route"].nunique())
    eq(f"kpi {k} pct_late", r["pct_late"], len(late) / len(o))
    eq(f"kpi {k} avg_late", r["avg_late_min"], late["arr_delay_min"].mean())
    eq(f"kpi {k} delay_h", r["delay_hours"], o.loc[o["arr_delay_min"] > 0, "arr_delay_min"].sum() / 60)

# aéroports
got = {(r["airline"], r["iata"]): r for r in calc["airports_by_airline"]}
for k in codes:
    d = sub(k)
    dep = d.groupby("origin").size()
    arr = d.groupby("destination").size()
    o = d[d["op"]]
    for iata in set(dep.index) | set(arr.index):
        r = got[(k, iata)]
        oo = o[o["origin"] == iata]
        eq(f"ap {k} {iata} dep", r["departures"], dep.get(iata, 0))
        eq(f"ap {k} {iata} arr", r["arrivals"], arr.get(iata, 0))
        eq(f"ap {k} {iata} pct", r["pct_dep_late"], (oo["dep_delay_min"] >= 15).mean() if len(oo) else 0)
        eq(f"ap {k} {iata} avg", r["avg_dep_delay"], oo["dep_delay_min"].mean() if len(oo) else 0)
eq("nb lignes aéroports", len(calc["airports_by_airline"]),
   sum(len(set(sub(k)["origin"]) | set(sub(k)["destination"])) for k in codes))

# lignes
got = {(r["airline"], r["route"]): r for r in calc["routes_by_airline"]}
for k in codes:
    d = sub(k)
    for route, g in d.groupby("route"):
        r = got[(k, route)]
        o = g[g["op"]]
        eq(f"rt {k} {route} flights", r["flights"], len(g))
        eq(f"rt {k} {route} pct", r["pct_late"], (o["arr_delay_min"] >= 15).mean() if len(o) else 0)
        eq(f"rt {k} {route} avg", r["avg_arr_delay"], o["arr_delay_min"].mean() if len(o) else 0)
eq("nb lignes routes", len(calc["routes_by_airline"]), sum(sub(k)["route"].nunique() for k in codes))

# heures
got = {(r["airline"], r["hour"]): r for r in calc["hours_by_airline"]}
for k in codes:
    d = sub(k)
    for h in range(24):
        g = d[d["hour"] == h]
        o = g[g["op"]]
        r = got[(k, h)]
        eq(f"hr {k} {h} deps", r["departures"], len(g))
        eq(f"hr {k} {h} pct", r["pct_dep_late"], (o["dep_delay_min"] >= 15).mean() if len(o) else 0)

# tranches
bins = [-10**6, 0, 14, 29, 59, 119, 10**6]
got = {(r["airline"], r["order"]): r for r in calc["buckets_by_airline"]}
for k in codes:
    o = sub(k)[sub(k)["op"]]
    cnt = pd.cut(o["arr_delay_min"], bins=bins, labels=range(6)).value_counts().reindex(range(6)).fillna(0)
    for i in range(6):
        eq(f"bk {k} {i}", got[(k, i)]["flights"], cnt[i])

# vols en l'air (tous les pas pour all, quelques compagnies pour le reste)
got = {(r["airline"], r["step"]): r["in_air"] for r in calc["airborne"]}
o = df[df["op"]].copy()
dep = (pd.to_datetime(o["actual_dep_utc"]) - day0).dt.total_seconds() / 60
arr = (pd.to_datetime(o["actual_arr_utc"]) - day0).dt.total_seconds() / 60
for k in ["all", "NVA", "CRD", "SVN"]:
    m = (o["airline_code"] == k) if k != "all" else pd.Series(True, index=o.index)
    for s in range(288):
        t = s * 5
        eq(f"air {k} {s}", got[(k, s)], ((dep[m] <= t) & (t < arr[m])).sum())

print(f"{n_checked} comparaisons, {bad} écart(s)")
sys.exit(1 if bad else 0)
