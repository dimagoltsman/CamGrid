// CamGrid — self-hosted camera viewer.
// Runs on the camera LAN (Docker), pulls streams directly via go2rtc, serves a web UI
// you reach from anywhere. No P2P/relay — the server is local to the cameras.
// Cameras come in two flavors: Reolink (probed by IP + credentials, RTSP derived) and
// generic "url" cameras (you paste the low/high stream URLs straight in).
import express from 'express';
import httpProxy from 'http-proxy';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReolinkClient } from './reolink.js';
import { discover } from './discovery.js';
import { loadCameras, saveCameras, newId } from './store.js';
import { startGo2rtc, waitReady, setStream, removeStream, syncStreams, go2rtcBaseURL } from './go2rtc.js';
import { authEnabled, requireAuth, loginHandler, logoutHandler, isAuthedCookieHeader } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

let cameras = loadCameras();

// ---- go2rtc stream wiring -------------------------------------------------

// go2rtc stream name for a camera channel (+ optional sub stream).
const streamName = (camId, channel, sub) => `${camId}_${channel}${sub ? '_sub' : ''}`;

function clientFor(cam) {
  return new ReolinkClient({
    host: cam.host, port: cam.port, useHTTPS: cam.useHTTPS,
    username: cam.username, password: cam.password,
  });
}

function streamsForCamera(cam) {
  // Generic camera: stream URLs were supplied directly. Single channel. Main = high
  // stream (falls back to low if none given), sub = low stream.
  if (cam.type === 'url') {
    return {
      [streamName(cam.id, 0, false)]: cam.highURL || cam.lowURL,
      [streamName(cam.id, 0, true)]: cam.lowURL,
    };
  }
  const client = clientFor(cam);
  const out = {};
  for (const ch of cam.channels) {
    out[streamName(cam.id, ch.index, false)] = client.rtspURL({ channel: ch.index, mainStream: true });
    out[streamName(cam.id, ch.index, true)] = client.rtspURL({ channel: ch.index, mainStream: false });
  }
  return out;
}

// Hostname out of a stream URL — used to name a generic camera when none is given.
function hostFromURL(u) {
  try { return new URL(u).hostname || null; } catch { return null; }
}

async function syncAllStreams() {
  const all = {};
  for (const cam of cameras) Object.assign(all, streamsForCamera(cam));
  await syncStreams(all);
}

// ---- camera management ----------------------------------------------------

// Probe a camera's API (best-effort) to capture model/channels/uid. Streaming works
// regardless (go2rtc pulls RTSP directly), so failures here are non-fatal.
async function probeCamera({ host, port, useHTTPS, username, password }) {
  const client = new ReolinkClient({ host, port, useHTTPS, username, password });
  let model = null, uid = null, channelNum = 1, channelNames = null;
  try {
    await client.login();
    const info = await client.getDeviceInfo().catch(() => null);
    if (info) { model = info.model; channelNum = info.channelNum || 1; }
    uid = await client.getP2pUID();
    if (channelNum > 1) {
      const status = await client._perform('GetChannelstatus', {}).catch(() => null);
      if (status?.status) channelNames = status.status.filter((s) => s.online).map((s) => ({ index: s.channel, name: s.name }));
    }
  } catch { /* API not reachable — still stream via RTSP */ }
  // Resolved scheme/port may have flipped during login.
  const channels = channelNames || Array.from({ length: channelNum }, (_, i) => ({ index: i, name: channelNum > 1 ? `Channel ${i + 1}` : (model || host) }));
  return { model, uid, channels, useHTTPS: client.useHTTPS, port: client.port };
}

// ---- HTTP API -------------------------------------------------------------

const app = express();
// Behind a reverse proxy (nginx) so req.ip / req.secure read X-Forwarded-* headers.
// Default: trust one hop. Set TRUST_PROXY=false if exposed directly with no proxy.
app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : Number(process.env.TRUST_PROXY) || 1);
app.use(express.json());

// --- public auth routes (must be before requireAuth) ---
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'login.html')));
app.post('/api/login', loginHandler);
app.post('/api/logout', logoutHandler);
app.get('/api/auth', (req, res) => res.json({ authEnabled, authed: isAuthedCookieHeader(req.headers.cookie) }));

// --- everything below requires a valid session ---
app.use(requireAuth);

// Strip credentials before sending camera objects to the browser. `ptz` and `hasHigh`
// let the UI hide controls a generic url camera can't drive (no API, maybe no HD stream).
const publicCamera = (cam) => ({
  id: cam.id, name: cam.name, host: cam.host || null, model: cam.model || null, uid: cam.uid || null,
  ptz: cam.type !== 'url',
  channels: cam.channels.map((ch) => ({
    index: ch.index, name: ch.name,
    main: streamName(cam.id, ch.index, false),
    sub: streamName(cam.id, ch.index, true),
    hasHigh: cam.type === 'url' ? !!cam.highURL : true,
  })),
});

app.get('/api/cameras', (_req, res) => res.json(cameras.map(publicCamera)));

app.post('/api/cameras', async (req, res) => {
  const body = req.body || {};

  // Generic camera: low/high stream URLs supplied directly (any go2rtc source — rtsp://,
  // http://, rtmp://…). No probe, no credentials, single channel.
  if (body.lowURL) {
    const lowURL = String(body.lowURL).trim();
    const highURL = body.highURL ? String(body.highURL).trim() : null;
    const hasScheme = (u) => /^[a-z][\w+.-]*:\/\//i.test(u);
    if (!hasScheme(lowURL) || (highURL && !hasScheme(highURL))) {
      return res.status(400).json({ error: 'stream URL must include a scheme, e.g. rtsp://…' });
    }
    const name = (body.name || '').trim() || hostFromURL(lowURL) || 'Camera';
    const cam = { id: newId(), type: 'url', name, lowURL, highURL, channels: [{ index: 0, name }] };
    cameras.push(cam);
    saveCameras(cameras);
    await syncStreams(streamsForCamera(cam));
    return res.json(publicCamera(cam));
  }

  // Reolink camera: probe by host + credentials, derive RTSP URLs.
  const { host, username = 'admin', password, name, useHTTPS = false, port } = body;
  if (!host || !password) return res.status(400).json({ error: 'host and password required' });
  try {
    const probed = await probeCamera({ host, port, useHTTPS, username, password });
    const cam = {
      id: newId(), name: name || probed.model || host, host,
      port: probed.port, useHTTPS: probed.useHTTPS, username, password,
      model: probed.model, uid: probed.uid, channels: probed.channels,
    };
    cameras.push(cam);
    saveCameras(cameras);
    await syncStreams(streamsForCamera(cam));
    res.json(publicCamera(cam));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.patch('/api/cameras/:id', (req, res) => {
  const cam = cameras.find((c) => c.id === req.params.id);
  if (!cam) return res.status(404).json({ error: 'not found' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  cam.name = name;
  // Single-channel cameras mirror the camera name on their one channel (what the UI shows).
  if (cam.channels.length === 1) cam.channels[0].name = name;
  saveCameras(cameras);
  res.json(publicCamera(cam));
});

app.delete('/api/cameras/:id', async (req, res) => {
  const cam = cameras.find((c) => c.id === req.params.id);
  if (!cam) return res.status(404).json({ error: 'not found' });
  for (const ch of cam.channels) {
    await removeStream(streamName(cam.id, ch.index, false));
    await removeStream(streamName(cam.id, ch.index, true));
  }
  cameras = cameras.filter((c) => c.id !== cam.id);
  saveCameras(cameras);
  res.json({ ok: true });
});

app.post('/api/scan', async (_req, res) => {
  try {
    const found = await discover();
    const known = new Set(cameras.map((c) => c.host));
    res.json(found.filter((f) => !known.has(f.host)));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/cameras/:id/ptz', async (req, res) => {
  const cam = cameras.find((c) => c.id === req.params.id);
  if (!cam) return res.status(404).json({ error: 'not found' });
  if (cam.type === 'url') return res.status(400).json({ error: 'PTZ not supported for url cameras' });
  const { op, channel = 0, speed = 32, presetId } = req.body || {};
  try {
    await clientFor(cam).ptz({ op, channel, speed, presetId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---- go2rtc proxy (single exposed port) -----------------------------------

const proxy = httpProxy.createProxyServer({ target: go2rtcBaseURL, ws: true });
proxy.on('error', (err, _req, res) => {
  if (res && !res.headersSent && res.writeHead) { res.writeHead(502); res.end('go2rtc unavailable'); }
});
// Express strips the '/go2rtc' mount prefix from req.url before this handler.
app.use('/go2rtc', (req, res) => proxy.web(req, res));

// ---- static UI ------------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'web')));

// ---- boot -----------------------------------------------------------------

const server = app.listen(PORT, () => console.log(`CamGrid on http://0.0.0.0:${PORT}`));

// WebSocket upgrades (go2rtc WebRTC/MSE) — handle here since express doesn't.
// Auth-gate them too, or anyone could view streams without logging in.
server.on('upgrade', (req, socket, head) => {
  if (!isAuthedCookieHeader(req.headers.cookie)) { socket.destroy(); return; }
  if (req.url.startsWith('/go2rtc')) {
    req.url = req.url.slice('/go2rtc'.length) || '/';
    proxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

if (!authEnabled) {
  console.warn('⚠️  AUTH_PASS not set — the UI is OPEN to anyone who can reach it. Set AUTH_USER/AUTH_PASS to require login.');
}

startGo2rtc();
waitReady().then((ok) => {
  if (!ok) console.error('[go2rtc] did not become ready');
  return syncAllStreams();
}).then(() => console.log(`[go2rtc] synced ${cameras.length} camera(s)`))
  .catch((e) => console.error('startup sync failed:', e));
