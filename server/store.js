// Simple JSON-file persistence for saved cameras (in the mounted /data volume).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'cameras.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadCameras() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function saveCameras(cameras) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(cameras, null, 2));
}

export function newId() {
  return crypto.randomUUID();
}
