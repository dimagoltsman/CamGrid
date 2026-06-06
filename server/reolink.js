// Reolink CGI API client (login, device info, PTZ) + RTSP URL building.
// Ported from the native client's ReolinkClient. Reolink forces HTTPS on newer
// firmware (302-redirects HTTP), so we auto-detect the scheme and trust self-signed
// LAN certs.
import https from 'node:https';
import http from 'node:http';

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

export class ReolinkClient {
  constructor({ host, port, useHTTPS = false, username, password }) {
    this.host = host;
    this.username = username;
    this.password = password;
    this.useHTTPS = useHTTPS;
    this.port = port || (useHTTPS ? 443 : 80);
    this.token = null;
    this.tokenExpiry = 0;
  }

  apiURL(cmd, token) {
    const scheme = this.useHTTPS ? 'https' : 'http';
    const q = new URLSearchParams({ cmd });
    if (token) q.set('token', token);
    return `${scheme}://${this.host}:${this.port}/cgi-bin/api.cgi?${q}`;
  }

  // RTSP URL for go2rtc to pull. channel is 0-based; pad to 2 digits + 1.
  rtspURL({ channel = 0, mainStream = true } = {}) {
    const stream = mainStream ? 'main' : 'sub';
    const chan = String(channel + 1).padStart(2, '0');
    const auth = `${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}`;
    return `rtsp://${auth}@${this.host}:554/h264Preview_${chan}_${stream}`;
  }

  async login() {
    try {
      return await this._login();
    } catch (err) {
      // Modern Reolink forces HTTPS; if HTTP gave a non-JSON/redirect, retry over TLS.
      if (!this.useHTTPS && err.schemeMismatch) {
        this.useHTTPS = true;
        if (this.port === 80) this.port = 443;
        return await this._login();
      }
      throw err;
    }
  }

  async _login() {
    const body = [{
      cmd: 'Login', action: 0,
      param: { User: { userName: this.username, password: this.password, Version: '0' } },
    }];
    const value = await this._send('Login', body, false);
    this.token = value.Token.name;
    this.tokenExpiry = Date.now() + (value.Token.leaseTime - 30) * 1000;
    return this.token;
  }

  async _validToken() {
    if (this.token && this.tokenExpiry > Date.now()) return this.token;
    return this.login();
  }

  async getDeviceInfo() {
    const value = await this._perform('GetDevInfo', {});
    return value.DevInfo;
  }

  async getP2pUID() {
    try {
      const value = await this._perform('GetP2p', {});
      return value?.P2p?.uid ?? null;
    } catch {
      return null;
    }
  }

  // op: Left/Right/Up/Down/ZoomInc/ZoomDec/Stop/ToPos; speed 1-64; id for presets.
  async ptz({ op, channel = 0, speed = 32, presetId }) {
    const param = { channel, op };
    if (op !== 'Stop') param.speed = speed;
    if (op === 'ToPos' && presetId != null) param.id = presetId;
    await this._perform('PtzCtrl', param);
  }

  async _perform(cmd, param, action = 0) {
    const body = [{ cmd, action, param }];
    try {
      return await this._send(cmd, body, true);
    } catch (err) {
      if (err.rspCode === -6 || err.rspCode === -26 || err.rspCode === -27) {
        this.token = null; // token expired — re-auth once
        return await this._send(cmd, body, true);
      }
      throw err;
    }
  }

  async _send(cmd, body, authenticated) {
    const token = authenticated ? await this._validToken() : undefined;
    const url = this.apiURL(cmd, token);
    const { status, text } = await this._post(url, JSON.stringify(body));

    if (status >= 300 && status < 400) {
      const e = new Error(`HTTP ${status} redirect`); e.schemeMismatch = true; throw e;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const e = new Error(`Non-JSON response: ${text.slice(0, 80)}`); e.schemeMismatch = true; throw e;
    }
    const first = json[0];
    if (!first) throw new Error('Empty response');
    if (first.code !== 0) {
      const e = new Error(first.error?.detail || 'API error');
      e.rspCode = first.error?.rspCode ?? first.code;
      throw e;
    }
    return first.value;
  }

  _post(url, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        agent: u.protocol === 'https:' ? insecureAgent : undefined,
        timeout: 10000,
      }, (res) => {
        // Don't auto-follow redirects — surface them so login can flip scheme.
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      });
      req.on('timeout', () => { req.destroy(); const e = new Error('timeout'); e.schemeMismatch = true; reject(e); });
      req.on('error', (e) => { e.schemeMismatch = true; reject(e); });
      req.write(body);
      req.end();
    });
  }
}
