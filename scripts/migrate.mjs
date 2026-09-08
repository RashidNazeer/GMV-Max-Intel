// Apply migrations to the GMV Intel database.
//
// Until now migrations were applied by hand, which is fine for one and a
// liability for fifteen: there was no record of which had run, and no way for
// anyone else to bring a database up to date. This does both, and it is the
// only thing in the repo that opens a Postgres connection.
//
// Every migration runs inside ONE transaction. A migration that fails halfway
// leaves a database in a state nobody designed and nobody tested, and the DO
// blocks at the bottom of these files exist precisely to abort — so the abort
// has to take the whole file with it.
//
//   node scripts/migrate.mjs             apply everything not yet applied
//   node scripts/migrate.mjs --status    list what has run
//   node scripts/migrate.mjs 015         apply one file by prefix (re-runnable)
//   node scripts/migrate.mjs --baseline 014
//                                        record everything up to 014 as applied
//                                        WITHOUT running it — for the files that
//                                        were applied by hand before this script
//                                        existed. Re-running those would drop and
//                                        rebuild live tables, so the only safe
//                                        move is to adopt them.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { env, need, ROOT_DIR } from './_env.mjs';

need('GMV_INTEL_PROJECT_REF', 'GMV_INTEL_DB_PASSWORD');

const DIR = path.join(ROOT_DIR, 'supabase', 'migrations');
const ref = env.GMV_INTEL_PROJECT_REF;
const pw = encodeURIComponent(env.GMV_INTEL_DB_PASSWORD);

// The pooler is the connection that works from anywhere; the direct host is
// IPv6-only on Supabase now and simply times out from most networks.
const HOSTS = [
  `postgresql://postgres.${ref}:${pw}@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`,
  `postgresql://postgres.${ref}:${pw}@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`,
  `postgresql://postgres.${ref}:${pw}@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres`,
];

async function connect() {
  let lastErr;
  for (const url of HOSTS) {
    const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      return client;
    } catch (e) {
      lastErr = e;
      try { await client.end(); } catch { /* already down */ }
    }
  }
  throw new Error(`could not connect to ${ref}: ${lastErr?.message}`);
}

const client = await connect();

// Notices are where the verification blocks speak. Swallowing them would hide
// the only output several of these migrations produce.
client.on('notice', (n) => console.log(`   · ${n.message}`));

await client.query(`
  create schema if not exists migrations;
  create table if not exists migrations.applied (
    filename    text primary key,
    applied_at  timestamptz not null default now(),
    checksum    text not null
  );
`);

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const { rows: done } = await client.query('select filename, checksum from migrations.applied');
const seen = new Map(done.map((r) => [r.filename, r.checksum]));

const arg = process.argv[2];

if (arg === '--status') {
  for (const f of files) {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const sum = hash(sql);
    const was = seen.get(f);
    console.log(
      `${was ? (was === sum ? 'applied ' : 'CHANGED ') : 'pending '} ${f}`,
    );
  }
  await client.end();
  process.exit(0);
}

if (arg === '--baseline') {
  const upTo = process.argv[3];
  if (!upTo) { console.error('--baseline needs a prefix, e.g. --baseline 014'); process.exit(1); }
  const adopt = files.filter((f) => f.slice(0, upTo.length) <= upTo);
  for (const f of adopt) {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    await client.query(
      `insert into migrations.applied (filename, checksum) values ($1, $2)
         on conflict (filename) do nothing`,
      [f, hash(sql)],
    );
  }
  console.log(`baselined ${adopt.length} migration(s) up to ${upTo} — recorded, not run`);
  await client.end();
  process.exit(0);
}

const targets = arg
  ? files.filter((f) => f.startsWith(arg))
  : files.filter((f) => !seen.has(f));

if (!targets.length) {
  console.log(arg ? `no migration matches "${arg}"` : 'nothing to apply — database is up to date');
  await client.end();
  process.exit(0);
}

for (const f of targets) {
  const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
  process.stdout.write(`${f} ... `);
  const t0 = Date.now();
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query(
      `insert into migrations.applied (filename, checksum) values ($1, $2)
         on conflict (filename) do update set checksum = excluded.checksum, applied_at = now()`,
      [f, hash(sql)],
    );
    await client.query('commit');
    console.log(`ok (${Date.now() - t0}ms)`);
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.log('FAILED');
    console.error(`\n${e.message}\n`);
    if (e.where) console.error(e.where);
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log(`\napplied ${targets.length} migration${targets.length === 1 ? '' : 's'}`);

function hash(s) {
  // Not cryptographic — it only needs to notice that a file changed after it
  // was applied, which is a thing worth being told about.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}
