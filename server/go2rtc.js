// Manages the go2rtc process — the streaming engine that pulls RTSP from each camera
// and serves it to browsers as WebRTC (low latency) with MSE fallback.
//
// We spawn go2rtc bound to localhost and add/remove streams at runtime via its REST
// API. The web server proxies browser traffic to it, so only one port is exposed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GO2RTC_BIN = process.env.GO2RTC_BIN || 'go2rtc';
const GO2RTC_PORT = 1984;
const DATA_DIR = process.env.DATA_DIR || '/data';

let proc = null;

export const go2rtcBaseURL = `http://127.0.0.1:${GO2RTC_PORT}`;

export function startGo2rtc() {
  if (proc) return;
  // Minimal config — streams are managed dynamically over the API.
  const configPath = path.join(DATA_DIR, 'go2rtc.yaml');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(configPath, `api:\n  listen: "127.0.0.1:${GO2RTC_PORT}"\nrtsp:\n  listen: ":8554"\nwebrtc:\n  listen: ":8555"\n`);

  proc = spawn(GO2RTC_BIN, ['-config', configPath], { stdio: ['ignore', 'inherit', 'inherit'] });
  proc.on('exit', (code) => {
    console.error(`[go2rtc] exited (${code}); restarting in 2s`);
    proc = null;
    setTimeout(startGo2rtc, 2000);
  });
}

async function api(method, pathname, timeout = 5000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${go2rtcBaseURL}${pathname}`, { method, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Wait until go2rtc's API is responsive (after spawn).
export async function waitReady(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await api('GET', '/api', 1000);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Add or replace a stream. `src` is an RTSP URL (or any go2rtc source).
export async function setStream(name, src) {
  // PUT replaces the source set for this name.
  await api('PUT', `/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`);
}

export async function removeStream(name) {
  try {
    await api('DELETE', `/api/streams?src=${encodeURIComponent(name)}`);
  } catch { /* ignore */ }
}

// Reconcile go2rtc's streams with the desired {name: src} map.
export async function syncStreams(streams) {
  for (const [name, src] of Object.entries(streams)) {
    try { await setStream(name, src); } catch (e) { console.error(`[go2rtc] setStream ${name}:`, e.message); }
  }
}
