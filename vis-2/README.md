# vis-2 View „waipu.tv" für iobroker.waipu

Fertige vis-2 View als JSON — zeigt Senderliste mit aktuellem + nächstem Programm.

## Import
1. Datei `waipu_view.json` herunterladen
2. ioBroker Admin → vis-2 Editor → Projekt `main` öffnen
3. **Project → Import** (oder Datei manuell in `vis-views.json` unter dem Key `"waipu.tv"` einfügen)
4. View „waipu.tv" in der Liste auswählen

## Datenpunkte
- Status: `waipu.0.info.connection`
- Pro Sender (Slug z. B. `ard`, `zdf`, `rtl`):
  - `waipu.0.channels.<slug>.currentProgram` — jetzt läuft
  - `waipu.0.channels.<slug>.currentProgramStart` / `...Stop` — Zeitfenster
  - `waipu.0.channels.<slug>.nextProgram` — als Nächstes
  - `waipu.0.channels.<slug>.epg` — komplettes EPG als JSON
- Aufnahmen: `waipu.0.recordings.<id>.title` / `.stationDisplay` / `.status` / `.durationSeconds`

## Anpassung
- Weitere Sender: in `waipu_view.json` Zeilen kopieren und `<slug>` ersetzen (alle 341 Sender unter `waipu.0.channels.*`)
- Layout: `style.left/top/width/height` der Widgets anpassen
