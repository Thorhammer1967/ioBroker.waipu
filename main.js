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
    this.log.info(`waipu adapter started, version ${this.version || this.common?.version || "0.0.1"}`);

    const cfg = this.config || {};

    this.username = cfg.username || "";
    this.password = cfg.password || "";
    const interval = Number(cfg.updateInterval);
    this.updateInterval = interval >= 5 && interval <= 1440 ? interval : 15;

    // --- deviceId sicherstellen und dauerhaft in der Instanz persistieren ---
    let deviceId = cfg.deviceId || "";
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      this.log.info(`No deviceId configured, generating new one: ${deviceId}`);
      try {
        await this.getForeignObjectAsync(`system.adapter.${this.namespace}`);
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, { native: { deviceId } });
      } catch (e) {
        this.log.warn(`deviceId could not be persisted: ${e.message}`);
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
            this.log.debug("Tokens persisted encrypted in instance object");
          }
        } catch (e) {
          this.log.warn(`Token persistence failed: ${e.message}`);
        }
      },
    });

    await this.setStateAsync("info.connection", false, true);

    // "info"-Ordner anlegen (Checker verlangt die Zwischenebene für info.connection)
    await this.setObjectNotExistsAsync("info", {
      type: "channel",
      common: { name: { en: "Information", de: "Informationen" } },
      native: {},
    });

    // --- Login / Token sicherstellen ---
    let loggedIn = false;
    try {
      if (cfg.accessToken || cfg.refreshToken) {
        this.log.info("Existing tokens found - using ensureToken() (refresh or password fallback)");
        await this.client.ensureToken();
      } else {
        this.log.info("No tokens - performing password login");
        await this.client.login(this.username, this.password);
      }
      loggedIn = true;
    } catch (e) {
      this.log.error(`Login failed: ${e.message}`);
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
    this.log.info(`Updates scheduled: every ${this.updateInterval} minutes (${intervalMs} ms)`);
    this._timer = this.setInterval(async () => {
      try {
        await this._updateAll();
      } catch (e) {
        this.log.error(`Periodic update run unexpectedly failed: ${e.stack || e.message}`);
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

      // Sammel-Objekt "channels" (device) anlegen – Checker verlangt die Zwischenebene
      await this.setObjectAsync("channels", {
        type: "device",
        common: { name: { en: "Channels (waipu.tv)", de: "Sender (waipu.tv)" } },
        native: {},
      });

      for (const s of visible) {
        const sid = String(s.id);
        const objId = this._escapeId(sid);
        this._stationIdMap.set(sid, objId);

        await this.setObjectAsync(`channels.${objId}`, {
          type: "channel",
          common: {
            name: s.displayName || sid,
          },
          native: {
            stationId: sid,
            logoUrl: s.logoUrl || null,
            favorite: !!s.favorite,
            recordingForbidden: !!s.recordingForbidden,
          },
        });

        await this.setObjectAsync(`channels.${objId}.currentProgramStart`, {
          type: "state",
          common: {
            name: { en: "Current program start", de: "Aktuelles Programm Beginn" },
            type: "number",
            role: "value.time",
            read: true,
            write: false,
          },
          native: {},
        });
        await this.setObjectAsync(`channels.${objId}.currentProgramStop`, {
          type: "state",
          common: {
            name: { en: "Current program end", de: "Aktuelles Programm Ende" },
            type: "number",
            role: "value.time",
            read: true,
            write: false,
          },
          native: {},
        });
        // Objekte für die in updateEPG geschriebenen States (sonst Warnung "no existing object")
        await this.setObjectAsync(`channels.${objId}.epg`, {
          type: "state",
          common: {
            name: { en: "EPG programs (JSON)", de: "EPG-Programme (JSON)" },
            type: "string",
            role: "json",
            read: true,
            write: false,
          },
          native: {},
        });
        await this.setObjectAsync(`channels.${objId}.currentProgram`, {
          type: "state",
          common: {
            name: { en: "Current program", de: "Aktuelles Programm" },
            type: "string",
            role: "text",
            read: true,
            write: false,
          },
          native: {},
        });
        await this.setObjectAsync(`channels.${objId}.nextProgram`, {
          type: "state",
          common: {
            name: { en: "Next program", de: "Nächstes Programm" },
            type: "string",
            role: "text",
            read: true,
            write: false,
          },
          native: {},
        });

        // Lesefreundliche Zeit-Strings für vis (HH:MM), zusätzlich zu den ms-Timestamps
        for (const [suffix, label] of [
          ["StartString", { en: "Current program start (HH:MM)", de: "Aktuelles Programm Beginn (HH:MM)" }],
          ["StopString", { en: "Current program end (HH:MM)", de: "Aktuelles Programm Ende (HH:MM)" }],
        ]) {
          await this.setObjectAsync(`channels.${objId}.currentProgram${suffix}`, {
            type: "state",
            common: { name: label, type: "string", role: "text", read: true, write: false },
            native: {},
          });
        }

        this._stationIds.push(sid);
      }

      this.log.info(`${visible.length} visible stations created/updated`);
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
        this.log.warn("updateEPG: no stations available");
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
          const title = current.title || current.name || "(unnamed)";
          const fmt = (t) => {
            const d = new Date(t);
            return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          };
          await this.setStateAsync(`channels.${objId}.currentProgram`, title, true);
          await this.setStateAsync(
            `channels.${objId}.currentProgramStart`,
            new Date(current.startTime).getTime(),
            true,
          );
          await this.setStateAsync(`channels.${objId}.currentProgramStop`, new Date(current.stopTime).getTime(), true);
          await this.setStateAsync(`channels.${objId}.currentProgramStartString`, fmt(current.startTime), true);
          await this.setStateAsync(`channels.${objId}.currentProgramStopString`, fmt(current.stopTime), true);
        } else {
          const empty = "—";
          await this.setStateAsync(`channels.${objId}.currentProgram`, empty, true);
          await this.setStateAsync(`channels.${objId}.currentProgramStart`, "", true);
          await this.setStateAsync(`channels.${objId}.currentProgramStop`, "", true);
          await this.setStateAsync(`channels.${objId}.currentProgramStartString`, "", true);
          await this.setStateAsync(`channels.${objId}.currentProgramStopString`, "", true);
        }

        if (next) {
          await this.setStateAsync(`channels.${objId}.nextProgram`, next.title || next.name || "(unnamed)", true);
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

      // Sammel-Objekt "recordings" (device) anlegen – Checker verlangt die Zwischenebene
      await this.setObjectAsync("recordings", {
        type: "device",
        common: { name: { en: "Recordings (waipu.tv)", de: "Aufnahmen (waipu.tv)" } },
        native: {},
      });

      // Objekte für Sammel-States (sonst Warnung "no existing object")
      await this.setObjectAsync("recordings.list", {
        type: "state",
        common: {
          name: { en: "Recordings (JSON)", de: "Aufnahmen (JSON)" },
          type: "string",
          role: "json",
          read: true,
          write: false,
        },
        native: {},
      });
      await this.setObjectAsync("recordings.count", {
        type: "state",
        common: {
          name: { en: "Number of recordings", de: "Anzahl Aufnahmen" },
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
        native: {},
      });

      await this.setStateAsync("recordings.list", JSON.stringify(recordings), true);
      await this.setStateAsync("recordings.count", recordings.length, true);

      for (const rec of recordings) {
        const rid = String(rec.recordingId || rec.id);
        const objId = this._escapeId(rid);
        const base = `recordings.${objId}`;

        // Channel-Eltern-Ebene für jede Aufnahme (Checker verlangt die Zwischenebene)
        await this.setObjectAsync(`${base}`, {
          type: "channel",
          common: { name: rec.title || `Recording ${rid}` },
          native: { recordingId: rid },
        });

        await this.setObjectAsync(`${base}.title`, {
          type: "state",
          common: { name: { en: "Title", de: "Titel" }, type: "string", role: "text", read: true, write: false },
          native: {},
        });
        await this.setObjectAsync(`${base}.status`, {
          type: "state",
          common: { name: { en: "Status", de: "Status" }, type: "string", role: "text", read: true, write: false },
          native: {},
        });
        await this.setObjectAsync(`${base}.stationDisplay`, {
          type: "state",
          common: { name: { en: "Channel", de: "Sender" }, type: "string", role: "text", read: true, write: false },
          native: {},
        });
        await this.setObjectAsync(`${base}.recordingStartTime`, {
          type: "state",
          common: {
            name: { en: "Recording start time", de: "Aufnahme-Startzeit" },
            type: "string",
            role: "text",
            read: true,
            write: false,
          },
          native: {},
        });
        await this.setObjectAsync(`${base}.durationSeconds`, {
          type: "state",
          common: {
            name: { en: "Duration (seconds)", de: "Dauer (Sekunden)" },
            type: "number",
            role: "value",
            unit: "s",
            read: true,
            write: false,
          },
          native: {},
        });
        await this.setObjectAsync(`${base}.epgStartTime`, {
          type: "state",
          common: {
            name: { en: "EPG start time", de: "EPG-Startzeit" },
            type: "string",
            role: "text",
            read: true,
            write: false,
          },
          native: {},
        });

        await this.setStateAsync(`${base}.title`, rec.title || "", true);
        await this.setStateAsync(`${base}.status`, rec.status || "", true);
        await this.setStateAsync(`${base}.stationDisplay`, rec.stationDisplay || "", true);
        await this.setStateAsync(`${base}.recordingStartTime`, rec.recordingStartTime || "", true);
        await this.setStateAsync(`${base}.durationSeconds`, Number(rec.durationSeconds) || 0, true);
        await this.setStateAsync(`${base}.epgStartTime`, rec.epgStartTime || "", true);
      }

      // Alte, nicht mehr vorhandene Aufnahme-Objekte entfernen (verwaiste States)
      const currentIds = new Set(recordings.map((r) => this._escapeId(String(r.recordingId || r.id))));
      const allObjs = await this.getAdapterObjectsAsync();
      const stale = [];
      for (const id of Object.keys(allObjs || {})) {
        // Keys kommen mit Namespace-Präfix (z.B. "waipu.0.recordings.123.title")
        const m = id.match(/recordings\.([^.]+)/);
        if (m && m[1] !== "list" && m[1] !== "count" && !currentIds.has(m[1])) {
          stale.push(id);
        }
      }
      for (const id of stale) {
        // getAdapterObjectsAsync liefert IDs MIT Namespace-Präfix ("waipu.0.…");
        // delObjectAsync erwartet eine ID OHNE Präfix.
        const rel = id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
        // Never delete objects that carry user configuration (history, influx, sql, ...)
        const existing = await this.getObjectAsync(rel);
        if (existing && existing.common && existing.common.custom && Object.keys(existing.common.custom).length) {
          this.log.warn(`Skipping deletion of ${rel}: common.custom is set (history/config attached)`);
          continue;
        }
        await this.delObjectAsync(rel);
      }
      if (stale.length) {
        this.log.info(`${stale.length} stale recording objects removed`);
      }

      this.log.debug(`Recordings updated: ${recordings.length}`);
    } catch (e) {
      await this._handleError(e, "updateRecordings");
    }
  }

  // --------------------------------------------------------------------
  // Fehlerbehandlung
  // --------------------------------------------------------------------
  async _handleError(e, context) {
    if (e instanceof WaipuAuthError) {
      this.log.error(`[${context}] Authentication error: ${e.message}`);
      try {
        await this.setStateAsync("info.connection", false, true);
      } catch {
        /* ignorieren */
      }
    } else if (e instanceof WaipuPermissionError) {
      this.log.warn(`[${context}] PermissionError: ${e.message}`);
    } else if (e instanceof WaipuApiError) {
      this.log.warn(`[${context}] API error: ${e.message} (retry at next interval)`);
    } else {
      this.log.error(`[${context}] Unexpected error: ${e.stack || e.message}`);
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
      this.log.info("waipu adapter stopped");
    } catch (e) {
      this.log.warn(`Error during unload: ${e.message}`);
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
