"use strict";

/**
 * iobroker.waipu (öffentlich: Sender, EPG, Aufnahmen)
 * Adapter-Hauptlogik für waipu.tv
 */

const utils = require("@iobroker/adapter-core");
const crypto = require("node:crypto");
const { WaipuClient, WaipuApiError, WaipuAuthError, WaipuPermissionError } = require("./lib/waipu-api.js");
const { DEFAULT_USER_AGENT, EPG_LOOKAHEAD_HOURS, EPG_LOOKBEHIND_MINUTES } = require("./lib/const.js");

class Waipu extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "waipu",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));

    this.client = null;
    this._timer = null;
    this._stationIds = [];
    /** Map stationId -> safe object id */
    this._stationIdMap = new Map();
  }

  /**
   * Bereite eine ID für die Verwendung als Objektpfad auf
   * (nur alphanumerisch, Tiefstriche, Bindestriche).
   *
   * @param {string} id
   * @returns {string}
   */
  _escapeId(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  async onReady() {
    this.log.info(`waipu Adapter gestartet, Version ${this.version || this.common?.version || "0.0.1"}`);

    const cfg = this.config || {};

    this.username = cfg.username || "";
    this.password = cfg.password || "";
    this.updateInterval = Number(cfg.updateInterval) > 0 ? Number(cfg.updateInterval) : 15;

    // --- deviceId sicherstellen und dauerhaft in der Instanz persistieren ---
    let deviceId = cfg.deviceId || "";
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      this.log.info(`Keine deviceId konfiguriert, generiere neue: ${deviceId}`);
      try {
        await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { deviceId } });
      } catch (e) {
        this.log.warn(`deviceId konnte nicht persistiert werden: ${e.message}`);
      }
      this.config.deviceId = deviceId;
    }

    // --- WaipuClient instanziieren ---
    this.client = new WaipuClient(this, {
      deviceId,
      accessToken: cfg.accessToken || "",
      refreshToken: cfg.refreshToken || "",
      username: this.username,
      password: this.password,
      userAgent: DEFAULT_USER_AGENT,
      onTokenChange: async (accessToken, refreshToken) => {
        try {
          // Fix #2: Tokens VOR dem Speichern mit dem System-Secret verschlüsseln,
          // damit sie nie im Klartext im Instanz-Objekt liegen.
          // Die Basisklasse entschlüsselt encryptedNative-Felder beim Start
          // automatisch in this.config → Login bleibt unverändert.
          // this.encrypt(value) nutzt das bereits geladene _systemSecret.
          const encAccess = accessToken ? this.encrypt(String(accessToken)) : "";
          const encRefresh = refreshToken ? this.encrypt(String(refreshToken)) : "";
          const obj = await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
          if (obj && obj.native) {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
              native: {
                accessToken: encAccess || obj.native.accessToken || "",
                refreshToken: encRefresh || obj.native.refreshToken || "",
              },
            });
            this.log.debug("Tokens im Instanz-Objekt verschlüsselt persistiert");
          }
        } catch (e) {
          this.log.warn(`Token-Persistenz fehlgeschlagen: ${e.message}`);
        }
      },
    });

    await this.setStateAsync("info.connection", false, true);

    // --- Login / Token sicherstellen ---
    let loggedIn = false;
    try {
      if (cfg.accessToken || cfg.refreshToken) {
        this.log.info("Vorhandene Token gefunden – nutze ensureToken() (Refresh bzw. Passwort-Fallback)");
        await this.client.ensureToken();
      } else {
        this.log.info("Keine Tokens – führe Passwort-Login durch");
        await this.client.login(this.username, this.password);
      }
      loggedIn = true;
    } catch (e) {
      this.log.error(`Login fehlgeschlagen: ${e.message}`);
      await this.setStateAsync("info.connection", false, true);
      // KEIN Abbruch: Der Adapter läuft weiter und wiederholt den Login
      // beim nächsten Update-Intervall (siehe _updateAll).
    }

    if (loggedIn) {
      await this.setStateAsync("info.connection", true, true);
    }

    // --- Einmaliger Initiallauf ---
    await this._updateAll();

    // --- Periodischer Lauf (updateInterval in Minuten, -> Millisekunden) ---
    const intervalMs = this.updateInterval * 60 * 1000;
    this.log.info(`Updates geplant: alle ${this.updateInterval} Minuten (${intervalMs} ms)`);
    this._timer = this.setInterval(async () => {
      try {
        await this._updateAll();
      } catch (e) {
        this.log.error(`Periodischer Update-Lauf unerwartet fehlgeschlagen: ${e.stack || e.message}`);
      }
    }, intervalMs);
  }

  /**
   * Führt alle Update-Routinen aus und setzt den Verbindungsstatus.
   */
  async _updateAll() {
    if (!this.client || !this._stationIds.length) {
      await this.updateStations();
    }
    await this.updateEPG();
    await this.updateRecordings();
  }

  // --------------------------------------------------------------------
  // Stations
  // --------------------------------------------------------------------
  async updateStations() {
    try {
      const stations = await this.client.getStations();
      const visible = stations.filter((s) => s.visible && !s.locked && !s.omitted);

      this._stationIds = [];
      this._stationIdMap.clear();

      for (const s of visible) {
        const sid = String(s.id);
        const objId = this._escapeId(sid);
        this._stationIdMap.set(sid, objId);

        await this.setObjectNotExistsAsync(`channels.${objId}`, {
          type: "channel",
          common: {
            name: s.displayName || sid,
            role: "media.channel",
          },
          native: {
            stationId: sid,
            logoUrl: s.logoUrl || null,
            favorite: !!s.favorite,
            recordingForbidden: !!s.recordingForbidden,
          },
        });

        await this.setObjectNotExistsAsync(`channels.${objId}.currentProgramStart`, {
          type: "state",
          common: {
            name: "Aktuelles Programm Beginn",
            type: "number",
            role: "value.time",
          },
          native: {},
        });
        await this.setObjectNotExistsAsync(`channels.${objId}.currentProgramStop`, {
          type: "state",
          common: {
            name: "Aktuelles Programm Ende",
            type: "number",
            role: "value.time",
          },
          native: {},
        });
        // Objekte für die in updateEPG geschriebenen States (sonst Warnung "no existing object")
        await this.setObjectNotExistsAsync(`channels.${objId}.epg`, {
          type: "state",
          common: {
            name: "EPG-Programme (JSON)",
            type: "string",
            role: "json",
          },
          native: {},
        });
        await this.setObjectNotExistsAsync(`channels.${objId}.currentProgram`, {
          type: "state",
          common: { name: "Aktuelles Programm", type: "string", role: "text" },
          native: {},
        });
        await this.setObjectNotExistsAsync(`channels.${objId}.nextProgram`, {
          type: "state",
          common: { name: "Nächstes Programm", type: "string", role: "text" },
          native: {},
        });

        this._stationIds.push(sid);
      }

      this.log.info(`${visible.length} sichtbare Sender angelegt/gepflegt`);
    } catch (e) {
      await this._handleError(e, "updateStations");
    }
  }

  // --------------------------------------------------------------------
  // EPG
  // --------------------------------------------------------------------
  async updateEPG() {
    try {
      if (!this._stationIds.length) {
        await this.updateStations();
      }
      if (!this._stationIds.length) {
        this.log.warn("updateEPG: keine Sender verfügbar");
        return;
      }

      const now = Date.now();
      const start = new Date(now - EPG_LOOKBEHIND_MINUTES * 60 * 1000);
      const end = new Date(now + EPG_LOOKAHEAD_HOURS * 60 * 60 * 1000);

      const programsByStation = await this.client.getProgramsInWindow(this._stationIds, start, end);

      for (const sid of this._stationIds) {
        const objId = this._stationIdMap.get(sid);
        if (!objId) {
          continue;
        }

        const programs = (programsByStation[sid] || []).filter((p) => p && p.startTime && p.stopTime);

        // EPG-JSON komplett setzen (mit Zeitstempel der Abfrage)
        await this.setStateAsync(
          `channels.${objId}.epg`,
          JSON.stringify({
            fetchedAt: now,
            programs,
          }),
          true,
        );

        let current = null;
        let next = null;
        for (const p of programs) {
          const startMs = new Date(p.startTime).getTime();
          const stopMs = new Date(p.stopTime).getTime();
          if (!current && startMs <= now && now < stopMs) {
            current = p;
          } else if (stopMs > now && !next && !current) {
            next = p;
          } else if (startMs > now) {
            // sortiert -> erstes künftiges Programm
            next = p;
            break;
          }
        }

        if (current) {
          const title = current.title || current.name || "(unbenannt)";
          await this.setStateAsync(`channels.${objId}.currentProgram`, title, true);
          await this.setStateAsync(
            `channels.${objId}.currentProgramStart`,
            new Date(current.startTime).getTime(),
            true,
          );
          await this.setStateAsync(`channels.${objId}.currentProgramStop`, new Date(current.stopTime).getTime(), true);
        } else {
          const empty = "—";
          await this.setStateAsync(`channels.${objId}.currentProgram`, empty, true);
          await this.setStateAsync(`channels.${objId}.currentProgramStart`, "", true);
          await this.setStateAsync(`channels.${objId}.currentProgramStop`, "", true);
        }

        if (next) {
          await this.setStateAsync(`channels.${objId}.nextProgram`, next.title || next.name || "(unbenannt)", true);
        } else {
          await this.setStateAsync(`channels.${objId}.nextProgram`, "", true);
        }
      }
    } catch (e) {
      await this._handleError(e, "updateEPG");
    }
  }

  // --------------------------------------------------------------------
  // Recordings
  // --------------------------------------------------------------------
  async updateRecordings() {
    try {
      const recordings = await this.client.getRecordings();

      // Objekte für Sammel-States (sonst Warnung "no existing object")
      await this.setObjectNotExistsAsync("recordings.list", {
        type: "state",
        common: { name: "Aufnahmen (JSON)", type: "string", role: "json" },
        native: {},
      });
      await this.setObjectNotExistsAsync("recordings.count", {
        type: "state",
        common: { name: "Anzahl Aufnahmen", type: "number", role: "value" },
        native: {},
      });

      await this.setStateAsync("recordings.list", JSON.stringify(recordings), true);
      await this.setStateAsync("recordings.count", recordings.length, true);

      for (const rec of recordings) {
        const rid = String(rec.recordingId || rec.id);
        const objId = this._escapeId(rid);
        const base = `recordings.${objId}`;

        await this.setObjectNotExistsAsync(`${base}.title`, {
          type: "state",
          common: { name: "Titel", type: "string", role: "text" },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${base}.status`, {
          type: "state",
          common: { name: "Status", type: "string", role: "text" },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${base}.stationDisplay`, {
          type: "state",
          common: { name: "Sender", type: "string", role: "text" },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${base}.recordingStartTime`, {
          type: "state",
          common: { name: "Aufnahme-Startzeit", type: "string", role: "text" },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${base}.durationSeconds`, {
          type: "state",
          common: {
            name: "Dauer (Sekunden)",
            type: "number",
            role: "value.duration",
          },
          native: {},
        });
        await this.setObjectNotExistsAsync(`${base}.epgStartTime`, {
          type: "state",
          common: { name: "EPG-Startzeit", type: "string", role: "text" },
          native: {},
        });

        await this.setStateAsync(`${base}.title`, rec.title || "", true);
        await this.setStateAsync(`${base}.status`, rec.status || "", true);
        await this.setStateAsync(`${base}.stationDisplay`, rec.stationDisplay || "", true);
        await this.setStateAsync(`${base}.recordingStartTime`, rec.recordingStartTime || "", true);
        await this.setStateAsync(`${base}.durationSeconds`, Number(rec.durationSeconds) || 0, true);
        await this.setStateAsync(`${base}.epgStartTime`, rec.epgStartTime || "", true);
      }

      this.log.debug(`Recordings aktualisiert: ${recordings.length}`);
    } catch (e) {
      await this._handleError(e, "updateRecordings");
    }
  }

  // --------------------------------------------------------------------
  // Fehlerbehandlung
  // --------------------------------------------------------------------
  async _handleError(e, context) {
    if (e instanceof WaipuAuthError) {
      this.log.error(`[${context}] Authentifizierungsfehler: ${e.message}`);
      try {
        await this.setStateAsync("info.connection", false, true);
      } catch {
        /* ignorieren */
      }
    } else if (e instanceof WaipuPermissionError) {
      this.log.warn(`[${context}] PermissionError: ${e.message}`);
    } else if (e instanceof WaipuApiError) {
      this.log.warn(`[${context}] API-Fehler: ${e.message} (Retry beim nächsten Intervall)`);
    } else {
      this.log.error(`[${context}] Unerwarteter Fehler: ${e.stack || e.message}`);
    }
  }

  async onUnload(callback) {
    try {
      if (this._timer) {
        this.clearInterval(this._timer);
        this._timer = null;
      }
      try {
        await this.setStateAsync("info.connection", false, true);
      } catch {
        /* ignorieren */
      }
      this.log.info("waipu Adapter beendet");
    } catch (e) {
      this.log.warn(`Fehler beim Unload: ${e.message}`);
    } finally {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new Waipu(options);
} else {
  new Waipu();
}
