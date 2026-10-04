# ioBroker.waipu

**English:** [README.md](README.md)

Integriert **waipu.tv** in ioBroker: Senderliste, EPG (Programmführer), das aktuell laufende Programm und die Cloud-Aufnahmen (DVR) — direkt als ioBroker-Datenpunkte.

> **Hinweis:** Dieser Adapter ist nicht von waipu.tv autorisiert. Er nutzt eine inoffizielle API, deren Endpunkte sich jederzeit ändern können.

**Hersteller / Dienst:** [https://www.waipu.tv](https://www.waipu.tv)

## Herkunft

Die Schnittstellen-Kenntnisse basieren auf der Open-Source-Arbeit an **ha-waipu** (Home-Assistant-Integration von GB-1972). Dieser Adapter ist eine eigene, für ioBroker neu gebaute Umsetzung — mit eigener Struktur, Fehlerbehandlung und Datenpunkten. Danke an die ha-waipu-Vorarbeit! 🙏

## Funktionsumfang

- **Senderliste:** Alle im Abo enthaltenen, sichtbaren Sender als Datenpunkte
- **EPG:** Laufendes und nächstes Programm je Sender, plus EPG-JSON im Blickfenster (30 min zurück / 2 h vor)
- **Cloud-Aufnahmen (DVR):** Liste, Anzahl und Details deiner waipu.tv-Aufnahmen
- **Verbindungsstatus:** `info.connection` zeigt den Login-/Verbindungszustand
- **Automatische Token-Erneuerung:** Session bleibt via Refresh-Token bestehen; Token werden verschlüsselt gespeichert

## Voraussetzungen

- ioBroker mit js-controller >= 3.3.0
- Ein gültiger **waipu.tv-Account** (Abo — Sender, EPG und DVR hängen vom Tarif ab)

## Installation

1. ioBroker öffnen → **Adapter** → Adapter installieren (npm oder Archiv)
2. Instanz hinzufügen (z. B. `waipu.0`)
3. In den Instanzeinstellungen **waipu.tv E-Mail** und **Passwort** eintragen
4.Update-Intervall wählen (Standard: 15 Minuten) und speichern — der Adapter loggt sich ein und füllt die Datenpunkte

## Konfiguration

| Feld | Beschreibung |
|------|--------------|
| **waipu.tv E-Mail** | E-Mail deines waipu.tv-Kontos |
| **waipu.tv Passwort** | Passwort deines waipu.tv-Kontos (verschlüsselt gespeichert) |
| **Update-Intervall (Minuten)** | 5–1440, Standard 15 |
| Device ID / Access Token / Refresh Token | Wird vom Adapter automatisch beim Login gefüllt (nur lesbar) |

## Datenpunkte

| State | Typ | Beschreibung |
|-------|-----|--------------|
| `info.connection` | boolean | Verbindung zu waipu.tv aktiv |
| `channels.<id>.*` | diverse | Sendername, Logo, EPG-JSON, `currentProgram`, `nextProgram`, Start/Stop-Zeiten |
| `recordings.list` | JSON | Alle Cloud-Aufnahmen (JSON) |
| `recordings.count` | number | Anzahl Aufnahmen |
| `recordings.<id>.*` | diverse | Titel, Status, Sender, Startzeit, Dauer je Aufnahme |

## Fehlerbehandlung

- **`info.connection = false` + Login-Fehler im Log:** Zugangsdaten prüfen, dann Instanz neu starten
- **Keine Sender / kein EPG:** Tarif prüfen (manche Sender sind gesperrt) und Log auf API-Änderungen prüfen
- **API-Änderungen:** Da die API inoffiziell ist, können sich Endpunkte jederzeit ändern — ein Adapter-Update behebt das üblicherweise

## Disclaimer

- Inoffizielle API, nicht von waipu.tv unterstützt
- Nutzung auf eigenes Risiko, private Nutzung gedacht; Nutzungsbedingungen von waipu.tv beachten
- Keine Haftung für Schäden oder Ausfälle

## Changelog

### 0.1.19
- Zuverlässige Veröffentlichung via npm-token wieder aktiviert.
### 0.1.18
- id-token-Schreibrecht für Trusted Publishing ergänzt.
### 0.1.17
- News exakt auf 7 gekürzt, Changelog 0.1.16 ergänzt.
### 0.1.16
- Trusted Publishing aktiviert (npm-token entfernt).
### 0.1.15
- Changelog 0.1.14 ergänzt, News auf 7 begrenzt.
### 0.1.14
- Changelog neu sortiert, News auf npm-Versionen begrenzt.
### 0.1.13
- News-Einträge auf veröffentlichte npm-Versionen beschränkt.

### 0.1.12
- Änderungseintrag für 0.1.11 ergänzt.

### 0.1.11
- README-Änderungsliste vervollständigt.

### 0.1.10
- News-Einträge an veröffentlichte npm-Versionen angeglichen.

### 0.1.9
- Veröffentlichung via npm-token in der CI wiederhergestellt.

### 0.1.5
- Vertrauenswürdiges Veröffentlichen konfiguriert; Release mit Prüfsignatur.

### 0.1.4
- Release-Automatisierung aktiviert (Publish via npm-token).

### 0.1.2
- Release-Automatisierung aktiviert; Veröffentlichung aus der CI mit Prüfsignatur.

### 0.1.0
- Erste öffentliche Version: Senderliste, EPG, aktuelles Programm, Cloud-Aufnahmen, Login + Token-Rotation.

## Lizenz

MIT — voller Text: [LICENSE](LICENSE).

Copyright (c) 2026 Thorhammer1967 <junk-alles@t-online.de>