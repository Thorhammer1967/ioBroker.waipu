# ioBroker.waipu

**Deutsch:** [README.de.md](README.de.md)

Integrates **waipu.tv** into ioBroker: channel list, EPG (TV guide), currently running programs and cloud recordings (DVR) — directly as ioBroker data points.

> **Note:** This adapter is not authorized by waipu.tv. It uses an unofficial API whose endpoints can change at any time.

**Manufacturer / service:** [https://www.waipu.tv](https://www.waipu.tv)

## Origin

The API knowledge is based on the open-source work on **ha-waipu** (Home Assistant integration by GB-1972). This adapter is a new, independent implementation for ioBroker — with its own structure, error handling and state management. Thanks to the ha-waipu groundwork! 🙏

## Features

- **Channel list:** all channels included in your subscription, as data points
- **EPG:** current and next program per channel, plus an EPG-JSON window (30 min back / 2 h ahead)
- **Cloud recordings (DVR):** list, count and details of your waipu.tv recordings
- **Connection status:** `info.connection` shows the login/connection state
- **Automatic token renewal:** the session stays alive via refresh token; tokens are stored encrypted

## Requirements

- ioBroker with js-controller >= 3.3.0
- A valid **waipu.tv account** (subscription — channels, EPG and DVR depend on your tariff)

## Installation

1. Open ioBroker → **Adapters** → install the adapter (from npm or an archive)
2. Add an instance (e.g. `waipu.0`)
3. Enter your **waipu.tv e-mail** and **password** in the instance settings
4. Choose an update interval (default: 15 minutes) and save — the adapter logs in and fills the data points

## Configuration

| Field | Description |
|-------|-------------|
| **waipu.tv e-mail** | E-mail of your waipu.tv account |
| **waipu.tv password** | Password of your waipu.tv account (stored encrypted) |
| **Update interval (minutes)** | 5–1440, default 15 |
| Device ID / Access Token / Refresh Token | Filled automatically by the adapter on login (read-only) |

## Data points

| State | Type | Description |
|-------|------|-------------|
| `info.connection` | boolean | Connection to waipu.tv active |
| `channels.<id>.*` | various | Channel name, logo, EPG JSON, `currentProgram`, `nextProgram`, start/stop times |
| `recordings.list` | JSON | All cloud recordings (JSON) |
| `recordings.count` | number | Number of recordings |
| `recordings.<id>.*` | various | Title, status, station, start time, duration per recording |

## Troubleshooting

- **`info.connection = false` + login errors in the log:** check your credentials, then restart the instance
- **No channels / no EPG:** check your tariff (some channels are locked) and the log for API changes
- **API changes:** since the API is unofficial, endpoints can change at any time — an adapter update usually fixes that

## Disclaimer

- Unofficial API, not supported by waipu.tv
- Use at your own risk, intended for private use; please observe the waipu.tv terms of use
- No liability for damage or outages

## Changelog

### 0.1.31
- Object structure fixes: read/write flags, device containers, valid roles (E1003/E1008/E3009).
### 0.1.28
- Checker fixes: full news translations, changelog link, token-free trusted publishing.
### 0.1.27
- Publish switched back to the proven npm token flow.
### 0.1.25
- npm publish via environment pinning (release).
### 0.1.24
- Trusted publishing fully configured; publish now with environment pinning.
### 0.1.23
- OIDC login verified; publish attempt after npm configuration.
### 0.1.22
- Trusted publishing configured at npm.
### 0.1.21
- Repository URL pinned to final location.
### 0.1.20
- News window trimmed to 7 entries.
### 0.1.19
- Re-check triggered from CI.
### 0.1.15
- Changelog 0.1.10 completed; 0.1.11 removed (never on npm).
### 0.1.14
- News trimmed to exactly 7.
### 0.1.13
- Changelog 0.1.9 added.
### 0.1.12
- Changelog 0.1.11 completed.
### 0.1.11
- README changelog completed.
### 0.1.10
- News entries aligned to published npm versions.
### 0.1.9
- Re-check triggered from CI.
### 0.1.5
- npm provenance activated.
### 0.1.4
- Release v0.1.3 removed (never released); versions cleaned up.
### 0.1.2
- Release-Automation enabled.
### 0.1.0
- First public version: channels, EPG, recordings.

Older entries: [CHANGELOG_OLD.md](./CHANGELOG_OLD.md)

## License

MIT — full text: [LICENSE](LICENSE).

Copyright (c) 2026 Thorhammer1967 <junk-alles@t-online.de>