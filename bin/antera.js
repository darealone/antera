#!/usr/bin/env node
// ANTERA command line: run the server, scaffold a config, re-check campaigns, verify the audit log.

// node:sqlite is stable enough for this use but still prints an experimental warning; hide only that one.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));

const { existsSync, copyFileSync, readFileSync } = await import('node:fs');
const { join, dirname, resolve } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const HELP = `ANTERA ${pkg.version} — decisions that hold (Foundation + Level 1: Prevent)

Usage:
  antera serve [--port 8080] [--host 127.0.0.1] [--data ./data/antera.db]
               [--config ./antera.config.json] [--secure-cookies] [--demo]
  antera init                     write antera.config.json (example) into this folder
  antera recheck [--data ...]     re-run every campaign's chain once (for cron); exit 1 if anything was paused
  antera verify-audit [--data ...]  check the audit log hash chain
  antera --version

Environment:
  PORT, HOST, ANTERA_DATA, ANTERA_CONFIG, ANTERA_SECURE_COOKIES=1
`;

const a = args(process.argv.slice(2));
const cmd = a._[0] ?? (a.version ? 'version' : 'help');
const dataFile = demo => resolve(a.data ?? process.env.ANTERA_DATA ?? (demo ? './data/demo.db' : './data/antera.db'));

async function config(overrides) {
  const { loadConfig } = await import('../src/config.js');
  try { return loadConfig(a.config ?? process.env.ANTERA_CONFIG ?? (existsSync('antera.config.json') ? 'antera.config.json' : null), overrides); }
  catch (e) { console.error(e.message); process.exit(1); }
}

if (cmd === 'version' || a.version) { console.log(pkg.version); process.exit(0); }
if (cmd === 'help' || a.help) { console.log(HELP); process.exit(0); }

if (cmd === 'init') {
  const target = resolve('antera.config.json');
  if (existsSync(target)) { console.error(`${target} already exists, not overwriting.`); process.exit(1); }
  copyFileSync(join(ROOT, 'examples', 'antera.config.example.json'), target);
  console.log(`Wrote ${target}\nEdit it, then run: antera serve --config antera.config.json`);
  process.exit(0);
}

if (cmd === 'serve') {
  const { createApp } = await import('../src/server.js');
  const demo = !!a.demo;
  const port = Number(a.port ?? process.env.PORT ?? 8080);
  const host = a.host ?? process.env.HOST ?? '127.0.0.1';
  const dbFile = dataFile(demo);
  const cfg = await config(demo ? { adapter: { type: 'demo' } } : {});
  const secureCookies = !!a['secure-cookies'] || process.env.ANTERA_SECURE_COOKIES === '1';
  const { server, svc, db } = createApp({ config: cfg, dbFile, demo, secureCookies });
  server.listen(port, host, async () => {
    const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
    if (demo && svc.needsSetup()) {
      const { seedDemo, DEMO_PASSWORD } = await import('../src/demo.js');
      await seedDemo(svc, db);
      console.log(`  Demo logins (password "${DEMO_PASSWORD}"): alex@example.test (admin), sam@example.test (approver), kim@example.test (marketing)`);
    }
    console.log(`ANTERA ${pkg.version} running on ${base}`);
    console.log(`  data:    ${dbFile}`);
    console.log(`  config:  ${cfg.file ?? '(defaults)'}`);
    console.log(`  adapter: ${svc.adapterType}${svc.adapterType === 'manual' ? ' (pauses become tasks; set adapter.type "webhook" to automate)' : ''}`);
    if (svc.needsSetup()) console.log('  First start: open the URL above to create the admin account.');
    if (demo) console.log('  DEMO MODE: fictitious team, campaigns and evidence. Do not use demo data in production.');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} else if (cmd === 'recheck') {
  const { openDb } = await import('../src/db.js');
  const { createService } = await import('../src/service.js');
  const db = openDb(dataFile(false));
  const svc = createService(db, await config());
  const before = new Map(db.all('SELECT id, state FROM campaigns').map(r => [r.id, r.state]));
  const out = await svc.recheckAll();
  let paused = 0;
  for (const r of out) {
    const was = before.get(r.id);
    if (was === 'live' && r.state === 'paused') paused++;
    console.log(`Campaign ${r.id}: ${was}${was !== r.state ? ' → ' + r.state.toUpperCase() : ''}  launch ${r.launch}  health ${r.health}`);
  }
  db.close();
  process.exit(paused ? 1 : 0);
} else if (cmd === 'verify-audit') {
  const { openDb } = await import('../src/db.js');
  const db = openDb(dataFile(false));
  const r = db.verifyAudit();
  console.log(r.ok ? 'Audit log intact.' : `Audit log broken at entry ${r.brokenAt}.`);
  process.exit(r.ok ? 0 : 1);
} else {
  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  process.exit(3);
}
