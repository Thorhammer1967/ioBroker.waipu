"use strict";

const axios = require("axios");

// --- Endpunkte (reverse-engineered aus ha-waipu / play.waipu.tv) ---
const AUTH_URL = "https://auth.waipu.tv/oauth/token";
const STATION_CATALOG_URL = "https://web-proxy.waipu.tv/station-config";
const USER_STATIONS_URL = "https://user-stations.waipu.tv/api/stations";
const GRID_SLOT_URL = "https://epg-cache.waipu.tv/api/grid/{station_id}/{slot}";
const RECORDINGS_URL = "https://recording.waipu.tv/api/recordings";

// Basic-Auth-Credentials der waipu Android-App (aus ha-waipu übernommen)
const CLIENT_BASIC_AUTH = "Basic YW5kcm9pZENsaWVudDpzdXBlclNlY3JldA==";

const ACCEPT_RECORDINGS = "application/vnd.waipu.recordings-extended-v4+json";
const CONTENT_CREATE_RECORDING = "application/vnd.waipu.recording-create-v4+json";
const CONTENT_DELETE_RECORDINGS = "application/vnd.waipu.recording-ids-v4+json";

const SLOT_HOURS = 4;
const TOKEN_REFRESH_THRESHOLD_SEC = 60;

class WaipuApiError extends Error {}

/**
 *
 */
class WaipuAuthError extends Error {}

/**
 *
 */
class WaipuPermissionError extends Error {}

/**
 * @param {string} token - JWT Token
 * @returns {object} - decodiertes Payload
 */
function decodeJwt(token) {
  const part = token.split(".")[1];
  const b64 = part.replace(/_/g, "/").replace(/-/g, "+");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

/**
 * @param {string|null} token
 * @param {number} thresholdSec - vor Ablauf als "ungültig" behandeln
 * @returns {boolean}
 */
function jwtIsValid(token, thresholdSec = 0) {
  if (!token) {
    return false;
  }
  try {
    const { exp } = decodeJwt(token);
    return exp && Date.now() / 1000 < exp - thresholdSec;
  } catch {
    return false;
  }
}

/**
 * Slot-Beginn (UTC), der ts enthält. waipu liefert EPG in 4h-Slots.
 *
 * @param {Date} ts
 * @param {number} slotHours
 * @returns {Date}
 */
function slotStartFor(ts, slotHours = SLOT_HOURS) {
  const d = new Date(ts);
  const hour = Math.floor(d.getUTCHours() / slotHours) * slotHours;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0, 0));
}

/**
 * Alle Slot-Beginn-Zeiten, deren 4h-Fenster [start, end) überdeckt.
 *
 * @param start
 * @param end
 */
function slotsCovering(start, end) {
  const slots = [];
  let cur = slotStartFor(start);
  const endMs = new Date(end).getTime();
  while (cur.getTime() < endMs) {
    slots.push(cur);
    cur = new Date(cur.getTime() + SLOT_HOURS * 3600 * 1000);
  }
  return slots;
}

function formatSlot(ts) {
  return ts.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 *
 */
class WaipuClient {
  /**
   * @param {object} adapter - ioBroker-Adapter-Instanz (für Logging / State-Persistenz)
   * @param {object} opts
   */
  constructor(adapter, opts = {}) {
    this.adapter = adapter;
    this.deviceId = opts.deviceId || "";
    this.accessToken = opts.accessToken || "";
    this.refreshToken = opts.refreshToken || "";
    this.username = opts.username || "";
    this.password = opts.password || "";
    this.userAgent = opts.userAgent || "iobroker.waipu/0.0.1";
    this.onTokenChange = opts.onTokenChange || null;

    this._http = axios.create({ timeout: 30000 });
  }

  // --- Credentials / Token persistieren --------------------------------

  _persistTokens(accessToken, refreshToken) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    if (this.onTokenChange) {
      this.onTokenChange(accessToken, refreshToken).catch((e) => {
        if (this.adapter) {
          this.adapter.log.debug(`Token persist failed: ${e.message}`);
        }
      });
    }
  }

  // --- Auth ------------------------------------------------------------

  /**
   *
   */
  async _tokenRequest(payload, isRefresh = false) {
    this.adapter.log.debug(`waipu token request (${isRefresh ? "refresh" : "password"} grant)`);
    const resp = await this._http.post(AUTH_URL, new URLSearchParams(payload), {
      headers: {
        Authorization: CLIENT_BASIC_AUTH,
        "User-Agent": this.userAgent,
      },
    });
    if (resp.status === 400 || resp.status === 401) {
      throw new WaipuAuthError(`Auth failed (${resp.status}): ${JSON.stringify(resp.data)}`);
    }
    const data = resp.data;
    if (!data.access_token) {
      throw new WaipuAuthError("Auth response missing access_token");
    }
    this._persistTokens(data.access_token, data.refresh_token || this.refreshToken);
  }

  async login(username, password) {
    this.username = username;
    this.password = password;
    await this._tokenRequest({
      username,
      password,
      grant_type: "password",
      waipu_device_id: this.deviceId,
    });
  }

  /**
   *
   */
  async ensureToken() {
    if (jwtIsValid(this.accessToken, TOKEN_REFRESH_THRESHOLD_SEC)) {
      return this.accessToken;
    }
    if (jwtIsValid(this.refreshToken)) {
      try {
        await this._tokenRequest(
          {
            refresh_token: this.refreshToken,
            grant_type: "refresh_token",
            waipu_device_id: this.deviceId,
          },
          true,
        );
        if (this.accessToken) {
          return this.accessToken;
        }
      } catch (e) {
        this.adapter.log.warn(`Refresh token rejected, falling back to password grant: ${e.message}`);
      }
    }
    if (this.username && this.password) {
      await this.login(this.username, this.password);
      return this.accessToken;
    }
    throw new WaipuAuthError("No valid token and no credentials for login");
  }

  // --- Generischer Request --------------------------------------------

  /**
   *
   */
  async _requestJson(method, url, { auth = true, accept = null, contentType = null, body = null } = {}) {
    const headers = { "User-Agent": this.userAgent };
    if (auth) {
      const token = await this.ensureToken();
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (accept) {
      headers["Accept"] = accept;
    }
    if (contentType) {
      headers["Content-Type"] = contentType;
    }

    const cfg = { method, url, headers };
    if (body !== null && body !== undefined) {
      cfg.data = JSON.stringify(body);
    }

    let resp;
    try {
      resp = await this._http.request(cfg);
    } catch (e) {
      if (e.response && e.response.status === 401) {
        throw new WaipuAuthError(`Unauthorized: ${method} ${url}`);
      }
      if (e.response && e.response.status === 403) {
        throw new WaipuPermissionError(`Forbidden: ${method} ${url}`);
      }
      throw new WaipuApiError(`${method} ${url} failed: ${e.message}`);
    }
    if (resp.status === 204) {
      return null;
    }
    const text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new WaipuApiError(`${method} ${url} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  // --- Stations ---------------------------------------------------------

  /**
   *
   */
  async getStationCatalog() {
    const data = await this._requestJson("GET", STATION_CATALOG_URL, {
      auth: false,
    });
    const out = {};
    for (const s of (data || {}).stations || []) {
      if (s.id) {
        out[s.id] = s;
      }
    }
    return out;
  }

  async getUserStations() {
    const data = await this._requestJson("GET", USER_STATIONS_URL, {
      auth: true,
    });
    return data || [];
  }

  /**
   * Gemergte Senderliste (nur die, die der User abonniert hat).
   *
   * @returns {Array<object>} { id, displayName, logoUrl, visible, locked, omitted, favorite, recordingForbidden }
   */
  async getStations() {
    const catalog = await this.getStationCatalog();
    const user = await this.getUserStations();
    const out = [];
    for (const u of user) {
      const sid = u.stationId || u.id;
      if (!sid) {
        continue;
      }
      const cat = catalog[sid] || {};
      const settings = u.userSettings || {};
      const restrictions = cat.restrictions || {};
      out.push({
        id: sid,
        displayName: u.displayName || cat.displayName || sid,
        logoUrl: this._fillLogo(cat.logoTemplateUrl, u.streamQuality),
        visible: settings.visible !== false,
        locked: !!u.locked,
        omitted: !!u.omitted,
        favorite: !!settings.favorite,
        recordingForbidden: !!restrictions.recordingForbidden,
      });
    }
    return out;
  }

  /**
   *
   */
  _fillLogo(templateUrl, quality = "hd") {
    if (!templateUrl) {
      return null;
    }
    return templateUrl
      .replace(/\$\{streamQuality\}/g, quality)
      .replace(/\$\{shape\}/g, "standard")
      .replace(/\$\{resolution\}/g, "320x180");
  }

  // --- EPG --------------------------------------------------------------

  /**
   *
   */
  async getGridSlot(stationId, slotStart) {
    const url = GRID_SLOT_URL.replace("{station_id}", String(stationId).toLowerCase()).replace(
      "{slot}",
      formatSlot(new Date(slotStart)),
    );
    try {
      const data = await this._requestJson("GET", url, { auth: false });
      return (data || []).map((p) => ({ stationId, ...p }));
    } catch (e) {
      this.adapter.log.debug(`Grid slot failed for ${stationId}: ${e.message}`);
      return [];
    }
  }

  async getProgramsInWindow(stationIds, start, end, maxConcurrent = 8) {
    const slots = slotsCovering(start, end);
    const out = {};
    for (const sid of stationIds) {
      out[sid] = [];
    }

    const queue = [];
    for (const sid of stationIds) {
      for (const slot of slots) {
        queue.push({ sid, slot });
      }
    }

    let idx = 0;
    const worker = async () => {
      while (idx < queue.length) {
        const job = queue[idx++];
        const programs = await this.getGridSlot(job.sid, job.slot);
        out[job.sid].push(...programs);
      }
    };
    const workers = Array.from({ length: Math.min(maxConcurrent, queue.length) }, () => worker());
    await Promise.all(workers);

    // dedup + sort
    for (const sid of Object.keys(out)) {
      const seen = {};
      for (const p of out[sid]) {
        seen[p.id] = p;
      }
      out[sid] = Object.values(seen).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    }
    return out;
  }

  // --- Recordings -------------------------------------------------------

  async getRecordings() {
    try {
      const data = await this._requestJson("GET", RECORDINGS_URL, {
        auth: true,
        accept: ACCEPT_RECORDINGS,
      });
      return data || [];
    } catch (e) {
      if (e instanceof WaipuPermissionError) {
        return [];
      }
      throw e;
    }
  }

  async createRecording(programId, stationId) {
    await this._requestJson("POST", RECORDINGS_URL, {
      auth: true,
      contentType: CONTENT_CREATE_RECORDING,
      body: { programId, stationId },
    });
  }

  /**
   *
   */
  async deleteRecordings(recordingIds) {
    if (!recordingIds || !recordingIds.length) {
      return;
    }
    await this._requestJson("DELETE", RECORDINGS_URL, {
      auth: true,
      contentType: CONTENT_DELETE_RECORDINGS,
      accept: ACCEPT_RECORDINGS,
      body: { recordingIds },
    });
  }
}

module.exports = {
  WaipuClient,
  WaipuApiError,
  WaipuAuthError,
  WaipuPermissionError,
  decodeJwt,
  jwtIsValid,
  slotsCovering,
  formatSlot,
};
