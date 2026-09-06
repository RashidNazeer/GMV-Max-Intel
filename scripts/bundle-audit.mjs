// Prove no secret reached the browser bundle.
//
// The spec is explicit (§46): Reacher credentials are server-only and must
// never appear in client requests or logs. A comment saying so is not evidence;
// this greps the built output for the actual secret values and fails loudly.
// Run after every build, and in CI once there is one.
import fs from 'node:fs';
import path from 'node:path';

const DIST = 'dist';
if (!fs.existsSync(DIST)) { console.error('no dist/ — run `npm run build` first'); process.exit(1); }

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
      .map((m) => [m[1], m[2]]).filter(([, v]) => v));
}

const local = readEnv('.env.local');
const wurx = readEnv(process.env.REACHER_KEYFILE || 'C:/Users/RA_shid/.wurx/cli-secrets.env');

// Values that must NEVER appear in a browser asset.
const forbidden = [
  ['REACHER_API', wurx.REACHER_API],
  ['SUPABASE_SERVICE_ROLE_KEY', local.SUPABASE_SERVICE_ROLE_KEY],
  ['GMV_INTEL_DB_PASSWORD', wurx.GMV_INTEL_DB_PASSWORD],
  ['SUPABASE_ACCESS_TOKEN', wurx.SUPABASE_ACCESS_TOKEN],
  ['GH_TOKEN', wurx.GH_TOKEN],
  ['VERCEL_TOKEN', wurx.VERCEL_TOKEN],
].filter(([, v]) => v);

// The anon key SHOULD be present — it is public by design and the app needs it.
const expected = [['VITE_SUPABASE_ANON_KEY', local.VITE_SUPABASE_ANON_KEY]].filter(([, v]) => v);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
})(DIST);

let leaked = 0;
console.log(`scanning ${files.length} built file(s)\n`);

for (const [name, value] of forbidden) {
  const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes(value));
  if (hits.length) {
    leaked++;
    console.log(`  LEAK   ${name} found in: ${hits.join(', ')}`);
  } else {
    console.log(`  clean  ${name} absent from the bundle`);
  }
}

for (const [name, value] of expected) {
  const present = files.some((f) => fs.readFileSync(f, 'utf8').includes(value));
  console.log(`  ${present ? 'ok    ' : 'MISSING'} ${name} ${present ? 'present (public by design)' : '— the app cannot reach Supabase'}`);
  if (!present) leaked++;
}

// Also catch a secret that was never in an env file: anything shaped like a
// Reacher key or a JWT carrying the service_role claim.
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  if (/\brk_[A-Za-z0-9_-]{20,}/.test(txt)) { console.log(`  LEAK   a Reacher-shaped key (rk_...) appears in ${f}`); leaked++; }
  if (/"role"\s*:\s*"service_role"/.test(txt)) { console.log(`  LEAK   a service_role JWT payload appears in ${f}`); leaked++; }
}

console.log(leaked ? `\nFAILED — ${leaked} problem(s)` : '\nPASS — no secret reached the browser bundle');
process.exit(leaked ? 1 : 0);
