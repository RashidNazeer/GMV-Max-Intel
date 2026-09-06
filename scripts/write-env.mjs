// One-off: parse `supabase projects api-keys` text output into .env.local.
// Run:  supabase projects api-keys --project-ref <ref> | node scripts/write-env.mjs <ref>
import fs from 'node:fs';

const ref = process.argv[2];
if (!ref) { console.error('usage: ... | node scripts/write-env.mjs <project-ref>'); process.exit(1); }

const raw = fs.readFileSync(0, 'utf8').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function grab(name) {
  for (const line of raw.split(/\r?\n/)) {
    const cols = line.split('|').map((c) => c.trim());
    if (cols.length >= 2 && cols[0] === name && cols[1]) return cols[1];
  }
  return null;
}

const anon = grab('anon');
const svc = grab('service_role');
if (!anon || !svc) {
  console.error('could not find anon / service_role rows in the output');
  process.exit(1);
}

fs.writeFileSync('.env.local',
  `VITE_SUPABASE_URL=https://${ref}.supabase.co\n` +
  `VITE_SUPABASE_ANON_KEY=${anon}\n` +
  `SUPABASE_SERVICE_ROLE_KEY=${svc}\n`);

console.log(`.env.local written — anon ${anon.length} chars, service_role ${svc.length} chars`);
