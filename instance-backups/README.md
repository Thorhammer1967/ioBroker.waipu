# ioBroker Instanz-Konfiguration Backup

Dieser Ordner enthält eine bereinigte Kopie der lokalen ioBroker-Instanzkonfiguration für `waipu.0`.

## Enthaltene Datei

- `system.adapter.waipu.0.json` – Schema und Einstellungen der Instanz (ohne Secrets).

## Was ist bereinigt?

Folgende sensiblen Felder sind leer gelassen und müssen nach dem Import neu befüllt werden:

- `native.password`
- `native.accessToken`
- `native.refreshToken`
- `native.deviceId` (wird beim ersten Start automatisch neu generiert, falls leer)

## Wiederherstellung in ioBroker

1. Zielsystem: ioBroker Admin öffnen.
2. Falls `waipu.0` noch nicht existiert: Adapter installieren und Instanz anlegen.
3. Im **Objekte**-Tab die Objekt-ID `system.adapter.waipu.0` bearbeiten.
4. Inhalt von `system.adapter.waipu.0.json` in das Objekt einfügen.
5. Eigenen `username` und `password` unter `native` eintragen.
6. Speichern und Instanz `waipu.0` neu starten.

Alternativ über die Kommandozeile:

```bash
# Nach dem Anpassen von username/password in der JSON-Datei:
cd /opt/iobroker
echo '[{"_id":"system.adapter.waipu.0",...}]' | iobroker object set -
```

## Hinweis

Das Passwort muss entweder im Klartext über die Admin-UI eingegeben werden oder mit dem System-Secret des Ziel-ioBrokers verschlüsselt werden. Bei der Admin-UI-Eingabe übernimmt ioBroker die Verschlüsselung automatisch.
