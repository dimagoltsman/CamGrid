// LAN discovery: sweep every local /24 for RTSP (port 554), then confirm each hit
// speaks the Reolink CGI API. Works even when ONVIF is disabled (Reolink's default),
// unlike WS-Discovery. Ported from the native client's LANScanner.
import net from 'node:net';
import os from 'node:os';
import { ReolinkClient } from './reolink.js';

function localSubnetPrefixes() {
  const prefixes = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        prefixes.add(a.address.split('.').slice(0, 3).join('.') + '.');
      }
    }
  }
  return [...prefixes];
}

function portOpen(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => { if (!done) { done = true; sock.destroy(); resolve(open); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function isReolink(host) {
  // A throwaway login: a Reolink device replies with JSON (auth error) on HTTPS or HTTP.
  for (const useHTTPS of [true, false]) {
    const client = new ReolinkClient({ host, useHTTPS, username: 'admin', password: 'x' });
    try {
      await client.login();
      return true; // unlikely, but it IS Reolink
    } catch (err) {
      // A real API error (wrong password) means we reached the Reolink JSON API.
      if (typeof err.rspCode === 'number') return true;
      // schemeMismatch / network error → try the other scheme / give up
    }
  }
  return false;
}

// Returns [{ host }] for every Reolink camera found on the local subnets.
export async function discover({ connectTimeout = 1200, concurrency = 128 } = {}) {
  const hosts = [];
  for (const prefix of localSubnetPrefixes()) {
    for (let i = 1; i <= 254; i++) hosts.push(`${prefix}${i}`);
  }

  // Sweep for open 554 in bounded batches.
  const rtspHosts = [];
  for (let i = 0; i < hosts.length; i += concurrency) {
    const batch = hosts.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((h) => portOpen(h, 554, connectTimeout).then((ok) => (ok ? h : null))));
    rtspHosts.push(...results.filter(Boolean));
  }

  // Confirm Reolink.
  const verified = await Promise.all(rtspHosts.map((h) => isReolink(h).then((ok) => (ok ? { host: h } : null))));
  return verified.filter(Boolean).sort((a, b) => a.host.localeCompare(b.host));
}
