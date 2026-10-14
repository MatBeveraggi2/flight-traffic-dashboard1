# Flight dashboard

Tableau de bord interactif du trafic aérien commercial sur une journée : aéroport le plus actif, compagnie avec le plus de vols, lignes les plus empruntées, retards, et une carte qui rejoue la journée vol par vol.

> **Les données de ce dépôt sont fictives.** Les aéroports sont réels (codes IATA), mais les compagnies, les horaires et tous les chiffres sont générés. Aucun résultat ne doit être lu comme une statistique réelle. La colonne `data_source` vaut `demo-synthetic` sur chaque ligne.

## Ce que fait le dashboard

- **Carte du monde** : aéroports (taille = mouvements, ou couleur = part de départs en retard), lignes les plus fréquentées, et les vols en l'air à l'heure choisie, avec lecture animée de la journée.
- **Filtre par compagnie** : chiffres clés, carte et tous les graphiques se recalculent.
- **Clic sur un aéroport** (carte ou graphique) : fiche avec mouvements, retards, destinations et compagnies présentes.
- **Survol d'une ligne** dans un classement : la ligne s'allume sur la carte.
- Classements : aéroports, compagnies, lignes ; retards par tranche, par heure, par aéroport, par ligne ; tableau de ponctualité triable.

## Contenu

```
src/reference.py            aéroports (réels) et compagnies (inventées)
src/generate_demo_data.py   génère le CSV de vols d'une journée
src/compute_metrics.py      indicateurs globaux (CSV -> JSON)
dashboard/                  page du dashboard : index.html, calcs.js, app.js, mapdata.js
tools/build-map.mjs         génère le fond de carte (mapdata.js) depuis world-atlas
tests/                      vérifications (voir plus bas)
data/                       CSV de vols, aéroports, indicateurs
```

`dashboard/calcs.js` recalcule chaque indicateur depuis les lignes de vols brutes, pour toutes les compagnies et pour chacune. `dashboard/app.js` ne fait que choisir la bonne tranche et la dessiner. Le dashboard utilise l'API `dash` de la plateforme où il est publié : il ne s'ouvre pas seul dans un navigateur.

## Lancer le pipeline

```bash
pip install -r requirements.txt
python src/generate_demo_data.py --day 2026-10-13
python src/compute_metrics.py data/flights_demo_2026-10-13.csv
```

Le générateur injecte un scénario pour que les chiffres aient du relief : des orages sur Chicago (ORD) en fin d'après-midi, heure locale, qui augmentent les retards et les annulations au départ.

## Vérifier

```bash
node tests/dump_calcs.js data/flights_demo_2026-10-13.csv /tmp/calcs.json
python tests/check_calcs.py data/flights_demo_2026-10-13.csv /tmp/calcs.json   # compare au recalcul pandas
NODE_PATH=./node_modules node tests/smoke_page.js data/flights_demo_2026-10-13.csv   # nécessite jsdom et d3
```

Le deuxième test compare plus de 15 000 valeurs (toutes compagnies, aéroports, lignes, heures, vols en l'air) à un recalcul indépendant avec pandas. Le troisième charge la page dans jsdom et change les filtres.

## Définitions

- **Retard** : arrivée (ou départ, selon l'indicateur) 15 minutes ou plus après l'heure prévue.
- **Mouvements** d'un aéroport : départs plus arrivées.
- **Ligne** : deux aéroports, les deux sens réunis.
- **Vol en l'air** : entre le décollage et l'atterrissage réels.
- Les vols annulés comptent dans les volumes, pas dans les retards. Heures en UTC.

## Passer sur de vraies données

Il suffit de produire un CSV avec ces colonnes (une ligne par vol programmé) :

| Colonne | Contenu |
|---|---|
| `flight_id` | identifiant unique du vol du jour |
| `airline_code`, `airline_name` | compagnie |
| `flight_number` | numéro de vol |
| `origin`, `destination` | codes IATA |
| `distance_km` | distance de la ligne |
| `scheduled_dep_utc`, `actual_dep_utc` | ISO 8601, UTC (`actual_*` vide si annulé) |
| `scheduled_arr_utc`, `actual_arr_utc` | idem |
| `dep_delay_min`, `arr_delay_min` | retards en minutes (vide si annulé) |
| `status` | `landed`, `cancelled` ou `diverted` |
| `data_source` | nom de la source |

Il faut aussi `data/airports.csv` avec les colonnes `iata, city, lat, lon` pour chaque aéroport du CSV.

Sources possibles : une API de statuts de vols (AeroDataBox, AirLabs, FlightAware AeroAPI) ou des exports de données ouvertes. Les positions seules (OpenSky) ne suffisent pas : elles n'indiquent ni compagnie, ni ligne, ni retard.
