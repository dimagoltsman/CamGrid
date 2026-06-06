// Reolink Web — front-end. Renders a grid of go2rtc <video-stream> players and wires
// up scan / add / PTZ against the backend API.

const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const addDialog = document.getElementById('addDialog');
const addForm = document.getElementById('addForm');
const discoveredEl = document.getElementById('discovered');
const addErr = document.getElementById('addErr');

const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const streamWS = (name) => `${wsProto}://${location.host}/go2rtc/api/ws?src=${encodeURIComponent(name)}`;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---- rendering ------------------------------------------------------------

function makePtz(camId, channel) {
  const ptz = document.createElement('div');
  ptz.className = 'ptz';
  const btns = [
    ['up', '↑', 'Up'], ['zin', '+', 'ZoomInc'],
    ['left', '←', 'Left'], ['right', '→', 'Right'],
    ['down', '↓', 'Down'], ['zout', '−', 'ZoomDec'],
  ];
  for (const [cls, label, op] of btns) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    const start = (e) => {
      e.preventDefault(); e.stopPropagation();
      api('POST', `/api/cameras/${camId}/ptz`, { op, channel }).catch(() => {});
    };
    const stop = (e) => {
      e.preventDefault(); e.stopPropagation();
      api('POST', `/api/cameras/${camId}/ptz`, { op: 'Stop', channel }).catch(() => {});
    };
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    ptz.appendChild(b);
  }
  return ptz;
}

function barButton(label, title, cls, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  if (cls) b.className = cls;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
  return b;
}

function toggleFullpage(tile, btn) {
  const on = tile.classList.toggle('fullpage');
  document.body.style.overflow = on ? 'hidden' : '';
  if (btn) { btn.textContent = on ? '🗗' : '⛶'; btn.title = on ? 'Exit full page' : 'Full page'; }
}

function makeTile(cam, channel) {
  const tile = document.createElement('div');
  tile.className = 'tile';

  let showingMain = false;

  // (re)mount the go2rtc player. go2rtc won't switch an already-streaming source via
  // `.src` (its onconnect() bails when a ws/pc exists), so to change quality we recreate
  // the element. Player goes first; the absolute bar/PTZ overlay it.
  const mountPlayer = (wsUrl) => {
    const old = tile.querySelector('video-stream');
    const p = document.createElement('video-stream');
    // MSE-only: WebRTC needs the browser to reach go2rtc's :8555 directly, which doesn't
    // survive a reverse proxy / symmetric NAT. MSE rides the existing WS through the proxy.
    p.setAttribute('mode', 'mse');
    p.background = true;
    p.src = wsUrl;
    if (old) old.replaceWith(p); else tile.prepend(p);
    setupVideoTile(tile);
  };

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.innerHTML = `<span class="dot"></span><span>${cam.name}${cam.channels.length > 1 ? ' · ' + channel.name : ''}</span><span class="spacer"></span>`;

  // Quality toggle: SD (sub stream) <-> HD (main stream). Only when an HD stream exists
  // (a url camera with just a low stream has nothing to switch to).
  const quality = channel.hasHigh ? barButton('SD', 'Switch to HD', 'quality', (btn) => {
    showingMain = !showingMain;
    btn.textContent = showingMain ? 'HD' : 'SD';
    btn.title = showingMain ? 'Switch to SD' : 'Switch to HD';
    mountPlayer(streamWS(showingMain ? channel.main : channel.sub));
  }) : null;
  const mute = barButton('🔇', 'Unmute', '', (btn) => {
    const v = tile.querySelector('video');
    if (!v) return;
    v.muted = !v.muted;
    btn.textContent = v.muted ? '🔇' : '🔊';
    btn.title = v.muted ? 'Unmute' : 'Mute';
    if (!v.muted) v.play?.().catch(() => {});
  });
  const expand = barButton('⛶', 'Full page', 'expand', () => toggleFullpage(tile, expand));
  const rename = barButton('✎', 'Rename', '', async () => {
    const next = prompt('Camera name', cam.name);
    if (next == null) return;
    const name = next.trim();
    if (!name || name === cam.name) return;
    await api('PATCH', `/api/cameras/${cam.id}`, { name });
    load();
  });
  const del = barButton('✕', 'Remove camera', '', async () => {
    if (!confirm(`Remove ${cam.name}?`)) return;
    await api('DELETE', `/api/cameras/${cam.id}`);
    load();
  });
  bar.append(...[quality, mute, rename, expand, del].filter(Boolean));

  // Double-click toggles full page (same as the ⛶ button).
  tile.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    toggleFullpage(tile, expand);
  });

  tile.append(bar);
  if (cam.ptz) tile.append(makePtz(cam.id, channel.index)); // url cameras have no PTZ
  mountPlayer(streamWS(channel.sub)); // initial: SD
  return tile;
}

// Esc exits full-page.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const fp = document.querySelector('.tile.fullpage');
  if (fp) toggleFullpage(fp, fp.querySelector('.expand'));
});

// go2rtc creates its <video> on connect (light DOM) with controls=true. Hook it the
// moment it appears: strip controls, mute (for autoplay), and size the tile to the
// stream's real dimensions. WebRTC reports size via 'resize', not 'loadedmetadata'.
function setupVideoTile(tile) {
  const player = tile.querySelector('video-stream');
  const fit = (v) => {
    if (v.videoWidth && v.videoHeight) tile.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
  };
  const hook = (v) => {
    v.controls = false;
    v.removeAttribute('controls');
    v.muted = true;
    v.addEventListener('loadedmetadata', () => fit(v));
    v.addEventListener('resize', () => fit(v));
    // Poll too — for WebRTC the 'resize' can fire before we attach, so events alone
    // race. Polling guarantees we pick up the real dimensions once a frame arrives.
    let tries = 0;
    const iv = setInterval(() => {
      fit(v);
      if ((v.videoWidth && v.videoHeight) || ++tries > 75) clearInterval(iv);
    }, 200);
  };
  const existing = player.querySelector('video') || player.video;
  if (existing) { hook(existing); return; }
  const mo = new MutationObserver(() => {
    const v = player.querySelector('video');
    if (v) { mo.disconnect(); hook(v); }
  });
  mo.observe(player, { childList: true, subtree: true });
}

// ---- grid layout ----------------------------------------------------------

// Fixed Reolink-style layouts vs the default responsive flow ('auto'). The choice is a
// class on the grid and is remembered across reloads.
const layoutSel = document.getElementById('layoutSel');
const LAYOUT_CLASSES = ['g2', 'g3', 'g4', 'hero'];
function applyLayout(v) {
  grid.classList.remove(...LAYOUT_CLASSES);
  if (LAYOUT_CLASSES.includes(v)) grid.classList.add(v);
  localStorage.setItem('layout', v);
}
{
  const saved = localStorage.getItem('layout') || 'auto';
  layoutSel.value = saved;
  applyLayout(saved);
}
layoutSel.addEventListener('change', () => applyLayout(layoutSel.value));

async function load() {
  const cams = await api('GET', '/api/cameras');
  grid.innerHTML = '';
  let tiles = 0;
  for (const cam of cams) {
    for (const ch of cam.channels) {
      grid.appendChild(makeTile(cam, ch)); // makeTile mounts + hooks the player
      tiles++;
    }
  }
  emptyEl.classList.toggle('hidden', tiles > 0);
}

// ---- add / scan -----------------------------------------------------------

function showDiscovered(list) {
  discoveredEl.innerHTML = '';
  for (const d of list) {
    const row = document.createElement('div');
    row.className = 'd';
    row.innerHTML = `<span>${d.host}</span>`;
    const use = document.createElement('button');
    use.textContent = 'Use';
    use.addEventListener('click', () => { addForm.host.value = d.host; addForm.password.focus(); });
    row.appendChild(use);
    discoveredEl.appendChild(row);
  }
}

// The add dialog has two modes: probe a Reolink camera by IP, or paste stream URLs directly.
const modeSeg = document.getElementById('modeSeg');
let addMode = 'ip';
function setMode(mode) {
  addMode = mode;
  for (const b of modeSeg.children) b.classList.toggle('active', b.dataset.mode === mode);
  addDialog.querySelector('.mode-ip').classList.toggle('hidden', mode !== 'ip');
  addDialog.querySelector('.mode-url').classList.toggle('hidden', mode !== 'url');
  addErr.textContent = '';
}
modeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

function openAddDialog() {
  addErr.textContent = '';
  discoveredEl.innerHTML = '';
  addForm.reset();
  addForm.username.value = 'admin';
  setMode('ip');
  addDialog.showModal();
}

document.getElementById('addBtn').addEventListener('click', openAddDialog);

document.getElementById('addCancel').addEventListener('click', () => addDialog.close());

document.getElementById('scanBtn').addEventListener('click', async () => {
  const btn = document.getElementById('scanBtn');
  btn.disabled = true; btn.textContent = 'Scanning…';
  try {
    const found = await api('POST', '/api/scan');
    openAddDialog();
    showDiscovered(found);
    if (!found.length) addErr.textContent = 'No new cameras found.';
  } catch (e) {
    alert('Scan failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Scan';
  }
});

addForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  addErr.textContent = '';
  const okBtn = document.getElementById('addOk');
  okBtn.disabled = true; okBtn.textContent = 'Adding…';
  try {
    const name = addForm.name.value.trim();
    if (addMode === 'url') {
      const lowURL = addForm.lowURL.value.trim();
      if (!lowURL) throw new Error('Low / SD stream URL is required');
      await api('POST', '/api/cameras', { name, lowURL, highURL: addForm.highURL.value.trim() });
    } else {
      const host = addForm.host.value.trim();
      if (!host || !addForm.password.value) throw new Error('Host and password are required');
      await api('POST', '/api/cameras', {
        host, name,
        username: addForm.username.value.trim(),
        password: addForm.password.value,
      });
    }
    addDialog.close();
    load();
  } catch (err) {
    addErr.textContent = err.message;
  } finally {
    okBtn.disabled = false; okBtn.textContent = 'Add';
  }
});

// Show the Sign-out button only when auth is enabled.
fetch('/api/auth').then((r) => r.json()).then((a) => {
  if (a.authEnabled) {
    const btn = document.getElementById('logoutBtn');
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      location.href = '/login';
    });
  }
}).catch(() => {});

load();
