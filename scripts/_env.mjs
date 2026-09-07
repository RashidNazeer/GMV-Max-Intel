// The ONE place this project reads configuration from.
//
// Everything comes from this project's own .env.local. Nothing reaches outside
// the repo for a credential — an earlier version read a shared secrets file
// belonging to a different project, which is exactly how two projects end up
// quietly coupled and how the wrong account gets touched.
//
// .env.local is git-ignored. It is never committed and never bundled: only
// VITE_* names are exposed to the browser (see vite.config.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, '.env.local');

function load() {
  if (!fs.existsSync(FILE)) {
    console.error(`Missing ${FILE}\n  Copy .env.example to .env.local and fill it in.`);
    process.exit(1);
  }
  const out = {};
  for (const line of fs.readFileSync(FILE, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) out[m[1]] = m[2];
  }
  return out;
}

export const env = load();
export const ROOT_DIR = ROOT;
export const ENV_FILE = FILE;

/** Fail loudly and usefully rather than sending `undefined` to an API. */
export function need(...keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Missing in .env.local: ${missing.join(', ')}`);
    process.exit(1);
  }
  return keys.map((k) => env[k]);
}

/** Persist a value back to .env.local (used when a script mints a password). */
export function setEnv(key, value) {
  const raw = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(raw)
    ? raw.replace(re, `${key}=${value}`)
    : `${raw.endsWith('\n') || raw === '' ? raw : raw + '\n'}${key}=${value}\n`;
  fs.writeFileSync(FILE, next);
  env[key] = value;
}
