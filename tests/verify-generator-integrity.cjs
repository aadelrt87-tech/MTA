/* Generator prototype data integrity: serialized Generator writes (one Web
   Lock for add, edit, run and delete) and unreadable runs that are never
   taken as "no runs".
   Part 1 runs generatorRepository extracted verbatim from MTA/index.html
   against an in-memory storage.
   Part 2 drives the app in Chromium, served as a static site (no backend).
   Two tabs of one browser context share localStorage and the origin's Web
   Locks; competing writes are ordered with the lock itself: the harness takes
   the Generator lock, waits (navigator.locks.query) until each tab's write is
   queued behind it, then lets go. GI1 also reproduces the race inside one page
   (two submissions that both read before either writes), which needs no lock
   and so also runs against a build without the fix.
   Run from the repository root: node tests/verify-generator-integrity.cjs
   PLAYWRIGHT_CORE=<path to playwright-core> loads it from there; otherwise
   playwright-core (or playwright) is found by normal Node resolution
   (a node_modules folder above this file, or NODE_PATH).
   RESULTS_DIR=<dir> receives the results JSON (default: the OS temp directory,
   so nothing is written inside the repository).
   TEST_HTML=<file> serves that file as index.html (e.g. the pre-fix build).
   ONLY=GI1,GI5,... runs just those Part 2 scenarios. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
// PLAYWRIGHT_CORE when set, otherwise normal Node resolution; no machine path.
function loadPlaywright() {
  if (process.env.PLAYWRIGHT_CORE) return require(path.resolve(process.env.PLAYWRIGHT_CORE));
  for (const name of ['playwright-core', 'playwright']) {
    let resolved;
    try { resolved = require.resolve(name); } catch (e) { continue; }
    return require(resolved);
  }
  console.error('playwright-core was not found. Install playwright-core (or playwright) where Node can resolve it ' +
    '(node_modules or NODE_PATH), or set PLAYWRIGHT_CORE to the path of an installed playwright-core.');
  process.exit(1);
}
const { chromium } = loadPlaywright();

const ROOT = path.resolve(__dirname, '..');
const HTML = process.env.TEST_HTML ? path.resolve(process.env.TEST_HTML) : path.join(ROOT, 'index.html');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.woff2': 'font/woff2' };
const NOW = new Date('2026-09-25T09:00:00Z'); // 12:00 Baghdad
const LOCK = 'genops_generator_write';
const CAT = 'genops_generator_catalog_v1';
const RUNS = 'genops_generator_runs_v1';
const CORRUPT = '{broken json';
const UNREADABLE = 'Stored data could not be read. No changes were saved.';
const NOT_SAVED = 'Device storage is full or unavailable. Your inputs are still in the form.';
const REFRESH = 'The latest closing record changed. The start is being reloaded; check your ending reading and time before retrying.';
const RUNTIME = 'Operating hours cannot exceed the elapsed time between start and end. Check the hour-meter readings.';

const results = { pass: [], fail: [] };
function check(name, fn) {
  try { fn(); results.pass.push(name); } catch (e) { results.fail.push(`${name} :: ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.pass.push(name); } catch (e) { results.fail.push(`${name} :: ${e.message}`); }
}
const want = (tag) => !process.env.ONLY || process.env.ONLY.split(',').includes(tag);
async function scenario(tag, body) {
  if (!want(tag)) return;
  try { await body(); } catch (e) { results.fail.push(`${tag} harness :: ${String((e && e.message) || e).split('\n')[0]}`); }
}

const items = (last) => ['engine_oil', 'oil_filter', 'primary_fuel_filter', 'air_filter']
  .map((type) => ({ type, enabled: true, intervalHours: 250, lastServiceHourMeter: last }))
  .concat(['secondary_fuel_filter', 'water_separator_filter'].map((type) => ({ type, enabled: false, intervalHours: null, lastServiceHourMeter: null })));
const gen = (id, name, initial, last) => ({ id, name, size: '250 kVA', initialHourMeter: initial, fuelConsumptionPerHour: 20,
  serviceItems: items(last), createdAt: 'x', updatedAt: 'x', active: true });
const baseline = (g, type) => g.serviceItems.find((i) => i.type === type).lastServiceHourMeter;

/* ======================= Part 1: generatorRepository ======================= */
const src = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n');
function block(start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, 'missing ' + start);
  const j = src.indexOf(end, i);
  return src.slice(i, j + end.length);
}
function fakeStorage(init) {
  const map = new Map(Object.entries(init || {}));
  const writes = [];
  return { map, writes, getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { writes.push(k); map.set(k, String(v)); }, removeItem: (k) => { writes.push('-' + k); map.delete(k); } };
}
async function part1() {
  let repo;
  try {
    repo = (store) => new Function('localStorage', 'CONFIG', [
      block('  function localListRead(key) {', '\n  }'),
      block('  function localListForWrite(key) {', '\n  }'),
      block('  const generatorRepository = (function () {', '\n  })();')
    ].join('\n') + '\nreturn generatorRepository;')(store, { LS_PREFIX: 'genops_' });
    assert.equal(typeof repo(fakeStorage()).loadRuns, 'function', 'generatorRepository.loadRuns');
  } catch (e) {
    results.fail.push('P1 strict generator reads present in the served index.html :: ' + e.message);
    return;
  }
  const cases = [['missing key', undefined, []], ['valid []', '[]', []],
    ['populated', '[{"id":"r1","generatorId":"g"}]', [{ id: 'r1', generatorId: 'g' }]]];
  for (const [label, raw, list] of cases) {
    await checkAsync(`P1.1 loadRuns / loadGenerators, ${label}: readable -> ${JSON.stringify(list)}`, async () => {
      const st = fakeStorage(raw === undefined ? {} : { [RUNS]: raw, [CAT]: raw });
      assert.deepEqual(await repo(st).loadRuns(), list);
      assert.deepEqual(await repo(st).loadGenerators(), list);
    });
  }
  for (const raw of [CORRUPT, '', 'null', '{}', '[{"name":"no id"}]']) {
    await checkAsync(`P1.2 loadRuns / loadGenerators, unreadable ${JSON.stringify(raw)}: rejected (STORAGE_UNREADABLE), never []; raw untouched`, async () => {
      const st = fakeStorage({ [RUNS]: raw, [CAT]: raw });
      await assert.rejects(repo(st).loadRuns(), (e) => e.code === 'STORAGE_UNREADABLE');
      await assert.rejects(repo(st).loadGenerators(), (e) => e.code === 'STORAGE_UNREADABLE');
      assert.deepEqual([st.map.get(RUNS), st.map.get(CAT), st.writes], [raw, raw, []]);
    });
  }
}

/* ======================= Part 2: the app in Chromium ======================= */
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = rel === 'index.html' ? HTML : path.join(ROOT, rel);
  if ((!file.startsWith(ROOT) && file !== HTML) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const origin = () => `http://127.0.0.1:${server.address().port}`;

// Runs in every page before the app: seeds once per context (strings raw),
// then the test-only hooks: lock trace, storage write count, harness hold.
function initScript(a) {
  localStorage.setItem('genops_language', a.lang);
  if (!localStorage.getItem('__seeded')) {
    Object.keys(a.seed).forEach((k) => localStorage.setItem(k, typeof a.seed[k] === 'string' ? a.seed[k] : JSON.stringify(a.seed[k])));
    localStorage.setItem('__seeded', '1');
  }
  if (a.noLocks) Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get() { return undefined; } });
  window.__writes = [];
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) { window.__writes.push(key); return setItem.call(this, key, value); };
  window.__trace = [];
  if (!window.LockManager) return;
  const request = LockManager.prototype.request;
  LockManager.prototype.request = function (name, ...rest) {
    const callback = rest.pop();
    const options = rest[0] || {};
    window.__trace.push('request');
    return request.call(this, name, options, async (lock) => {
      window.__trace.push('enter');
      try { return await callback(lock); } finally { window.__trace.push('exit'); }
    });
  };
  window.__harnessHold = (name) => new Promise((granted) => {
    request.call(navigator.locks, name, { mode: 'exclusive' }, () => new Promise((release) => {
      window.__harnessRelease = release;
      granted(true);
    }));
  });
}
async function openTabs(browser, o) {
  const opts = Object.assign({ lang: 'en', seed: {}, tabs: 1, noLocks: false }, o);
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block',
    timezoneId: 'Asia/Baghdad', locale: 'en-US' });
  const external = [];
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(origin() + '/')) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(initScript, { lang: opts.lang, seed: opts.seed, noLocks: opts.noLocks });
  const pages = [];
  const errors = [];
  for (let i = 0; i < opts.tabs; i++) {
    const page = await context.newPage();
    await page.clock.setFixedTime(NOW);
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    await page.goto(origin() + '/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(1100);
    if (!(await page.$eval('#authLoginScreen', (e) => e.hidden))) {
      await page.fill('#authUsername', 'tester'); await page.fill('#authPasscode', '1');
      await page.click('#authLoginButton'); await page.waitForTimeout(500);
    }
    await page.click('#nav-generators'); await page.waitForTimeout(200);
    if (await page.$eval('#secBodyGen', (e) => e.hidden)) { await page.click('#secHeadGen'); await page.waitForTimeout(250); }
    pages.push(page);
  }
  return { context, pages, errors, external };
}
const raw = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const ls = async (page, key) => JSON.parse(await raw(page, key)) || [];
const toasts = (page) => page.$$eval('#toastStack .toast', (ts) => ts.map((t) =>
  [t.querySelector('.t-title').textContent, (t.querySelector('.t-msg') || { textContent: '' }).textContent]));
const clearToasts = (page) => page.evaluate(() => { document.getElementById('toastStack').textContent = ''; });
const click = (page, selector) => page.evaluate((s) => document.querySelector(s).click(), selector);
const traceOf = (page) => page.evaluate(() => window.__trace.slice());
async function lockState(page) {
  return page.evaluate(async (name) => {
    if (!navigator.locks) return { held: 0, pending: 0 };
    const s = await navigator.locks.query();
    return { held: s.held.filter((l) => l.name === name).length, pending: s.pending.filter((l) => l.name === name).length };
  }, LOCK);
}
async function until(page, predicate, what) {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await page.waitForTimeout(15); }
  throw new Error('timed out waiting for ' + what);
}
const waitPending = (page, n) => until(page, async () => (await lockState(page)).pending === n, n + ' pending Generator lock request(s)');
async function waitIdle(pages) {
  await until(pages[0], async () => {
    const s = await lockState(pages[0]);
    if (s.held || s.pending) return false;
    for (const p of pages) {
      const t = await traceOf(p);
      if (t.filter((x) => x === 'request').length !== t.filter((x) => x === 'exit').length) return false;
    }
    return true;
  }, 'the Generator lock to be idle');
  for (const p of pages) await p.waitForTimeout(350);
}
async function holdLock(page) { await page.evaluate((n) => window.__harnessHold(n), LOCK); }
const releaseLock = (page) => page.evaluate(() => window.__harnessRelease());
async function fillRun(page, id, start, end, endHm, services) {
  await page.selectOption('#gen-name', id); await page.waitForTimeout(250);
  if (start && !(await page.$eval('#gen-start-dt', (e) => e.readOnly))) await page.fill('#gen-start-dt', start);
  await page.fill('#gen-end-dt', end);
  await page.fill('#gen-end-hm', String(endHm));
  for (const s of services || []) await page.click(`#oilsFiltersGrid .check-item[data-value="${s}"]`);
  await page.waitForTimeout(80);
}
async function openEdit(page, id, name) {
  await page.click(`#generatorOpsList [data-genmgr-edit="${id}"]`); await page.waitForTimeout(350);
  await page.fill('#genmgr-name', name);
}
async function openDelete(page, id) {
  await page.click(`#generatorOpsList [data-genmgr-delete="${id}"]`);
  await until(page, () => page.evaluate((i) => !!document.querySelector(`#generatorOpsList .genmgr-ov[data-genmgr-id="${i}"] .ops-panel .ops-delete`), id), 'the delete panel');
}
const confirmDelete = (id) => `#generatorOpsList .genmgr-ov[data-genmgr-id="${id}"] .ops-panel .ops-delete`;
const runtimeOf = (page, id) => page.$$eval(`#generatorOpsList .genmgr-ov[data-genmgr-id="${id}"] .genmgr-ov-runtime .genmgr-num`, (n) => n.map((x) => x.textContent));
const currentMeter = (catalog, runs, id) => {
  const own = runs.filter((r) => r.generatorId === id);
  return own.length ? own[own.length - 1].endHourMeter : catalog.find((g) => g.id === id).initialHourMeter;
};
const SEED_G = { [CAT]: [gen('id_g', 'Gen A', 100, 100)] };

async function part2(browser) {
  /* ---------- GI1. one page, two submissions that both read before either writes ---------- */
  await scenario('GI1', async () => {
    const { context, pages: [p], errors, external } = await openTabs(browser, { seed: SEED_G });
    await fillRun(p, 'id_g', '2026-09-25T08:00', '2026-09-25T09:00', 101);
    await clearToasts(p);
    // A second app instance is simulated by lifting the button guard between the two submissions.
    await p.evaluate(() => {
      const form = document.getElementById('formGenerators');
      const button = document.getElementById('btnSubmitGen');
      form.requestSubmit();
      button.disabled = false; button.classList.remove('loading');
      form.requestSubmit();
    });
    await waitIdle([p]);
    const runs = await ls(p, RUNS);
    const catalog = await ls(p, CAT);
    const shown = await toasts(p);
    const runtime = await runtimeOf(p, 'id_g');
    check('GI1.1 two identical runs 100 -> 101 (08:00-09:00) from the same opening state: exactly one saved', () => {
      assert.equal(runs.length, 1);
      assert.deepEqual([runs[0].startHourMeter, runs[0].endHourMeter, runs[0].operatingHours], [100, 101, 1]);
    });
    check('GI1.2 the second re-reads the saved run and is refused as stale (Save not confirmed)', () =>
      assert.deepEqual(shown.map((t) => t[0]).sort(), ['Save not confirmed', 'Saved']));
    check('GI1.3 current meter 101; runtime counted once (Today 1.0 h, This Month 1.0 h)', () => {
      assert.equal(currentMeter(catalog, runs, 'id_g'), 101);
      assert.deepEqual(runtime, ['1.0', '1.0']);
    });
    check('GI1.4 zero console errors, zero external requests', () => assert.deepEqual([errors, external], [[], []]));
    await context.close();
  });

  /* ---------- GI2. two tabs: the same run queued twice behind the Generator lock ---------- */
  await scenario('GI2', async () => {
    const { context, pages: [p1, p2], errors } = await openTabs(browser, { seed: SEED_G, tabs: 2 });
    for (const p of [p1, p2]) { await fillRun(p, 'id_g', '2026-09-25T08:00', '2026-09-25T09:00', 101); await clearToasts(p); }
    await holdLock(p1);
    await click(p1, '#btnSubmitGen'); await waitPending(p1, 1);
    await click(p2, '#btnSubmitGen'); await waitPending(p1, 2);
    const queued = await raw(p1, RUNS);
    await releaseLock(p1); await waitIdle([p1, p2]);
    const runs = await ls(p1, RUNS);
    const out = [await toasts(p1), await toasts(p2)];
    check('GI2.1 both runs were queued on the Generator lock before either was saved', () => assert.equal(queued, null));
    check('GI2.2 exactly one 100 -> 101 run; the second tab re-read it and was refused', () => {
      assert.equal(runs.length, 1);
      assert.deepEqual(out, [[['Saved', 'Record saved on this device.']], [['Save not confirmed', REFRESH]]]);
    });
    const traces = [await traceOf(p1), await traceOf(p2)];
    check('GI2.3 each tab entered and left the Generator critical section once', () =>
      assert.deepEqual(traces, [['request', 'enter', 'exit'], ['request', 'enter', 'exit']]));
    check('GI2.4 zero console errors', () => assert.deepEqual(errors, []));
    await context.close();
  });

  /* ---------- GI3. two tabs: run (with a service) vs delete ---------- */
  for (const runFirst of [true, false]) {
    const tag = runFirst ? 'GI3a' : 'GI3b';
    await scenario(tag, async () => {
      const { context, pages: [p1, p2], errors } = await openTabs(browser, { seed: SEED_G, tabs: 2 });
      await fillRun(p1, 'id_g', '2026-09-25T08:00', '2026-09-25T09:00', 101, ['engine_oil']);
      await openDelete(p2, 'id_g');
      for (const p of [p1, p2]) await clearToasts(p);
      await holdLock(p1);
      const steps = [() => click(p1, '#btnSubmitGen'), () => click(p2, confirmDelete('id_g'))];
      if (!runFirst) steps.reverse();
      await steps[0](); await waitPending(p1, 1);
      await steps[1](); await waitPending(p1, 2);
      await releaseLock(p1); await waitIdle([p1, p2]);
      const g = (await ls(p1, CAT))[0];
      const runs = await ls(p1, RUNS);
      const out = [await toasts(p1), await toasts(p2)];
      if (runFirst) {
        check(`${tag}.1 run first: run saved (oil baseline 101), then deleted; history kept`, () => {
          assert.deepEqual([runs.length, g.active, typeof g.archivedAt, baseline(g, 'engine_oil')], [1, false, 'string', 101]);
          assert.deepEqual(out, [[['Saved', 'Record saved on this device.']], [['Generator deleted', '']]]);
        });
      } else {
        check(`${tag}.1 delete first: the run re-read an archived generator and was refused; no run, no baseline change`, () => {
          assert.deepEqual([runs.length, g.active, baseline(g, 'engine_oil')], [0, false, 100]);
          assert.deepEqual(out, [[['Save not confirmed', REFRESH]], [['Generator deleted', '']]]);
        });
      }
      // A run that records a service rewrites the generator record; it must
      // never write back a record read before the delete.
      check(`${tag}.2 the deleted generator stays deleted (no run write restored it)`, () =>
        assert.deepEqual([g.active, g.archivedAt === null], [false, false]));
      check(`${tag}.3 zero console errors`, () => assert.deepEqual(errors, []));
      await context.close();
    });
  }

  /* ---------- GI4. two tabs: run (with a service) vs edit (name only) ---------- */
  for (const runFirst of [true, false]) {
    const tag = runFirst ? 'GI4a' : 'GI4b';
    await scenario(tag, async () => {
      const { context, pages: [p1, p2], errors } = await openTabs(browser, { seed: SEED_G, tabs: 2 });
      await fillRun(p1, 'id_g', '2026-09-25T08:00', '2026-09-25T09:00', 101, ['engine_oil']);
      await openEdit(p2, 'id_g', 'Gen Renamed');
      for (const p of [p1, p2]) await clearToasts(p);
      await holdLock(p1);
      const steps = [() => click(p1, '#btnSubmitGen'), () => click(p2, '#genmgrSaveBtn')];
      if (!runFirst) steps.reverse();
      await steps[0](); await waitPending(p1, 1);
      await steps[1](); await waitPending(p1, 2);
      await releaseLock(p1); await waitIdle([p1, p2]);
      const g = (await ls(p1, CAT))[0];
      const runs = await ls(p1, RUNS);
      const out = [await toasts(p1), await toasts(p2)];
      check(`${tag}.1 both saved, neither lost: new name, run kept, oil baseline 101, other baselines 100, initial meter 100`, () => {
        assert.deepEqual([g.name, runs.length, g.initialHourMeter], ['Gen Renamed', 1, 100]);
        assert.deepEqual(g.serviceItems.filter((i) => i.enabled).map((i) => [i.type, i.lastServiceHourMeter]),
          [['engine_oil', 101], ['oil_filter', 100], ['primary_fuel_filter', 100], ['air_filter', 100]]);
        assert.deepEqual(out, [[['Saved', 'Record saved on this device.']], [['Generator updated', '']]]);
      });
      check(`${tag}.2 zero console errors`, () => assert.deepEqual(errors, []));
      await context.close();
    });
  }

  /* ---------- GI5. unreadable runs + edit name only (Finding 2) ---------- */
  await scenario('GI5', async () => {
    const seed = { [CAT]: [gen('id_g', 'Gen A', 100, 200)], [RUNS]: CORRUPT };
    const { context, pages: [p], errors } = await openTabs(browser, { seed });
    const before = { cat: await raw(p, CAT), runs: await raw(p, RUNS) };
    await openEdit(p, 'id_g', 'Gen Renamed');
    await clearToasts(p);
    await click(p, '#genmgrSaveBtn'); await waitIdle([p]);
    const after = { cat: await raw(p, CAT), runs: await raw(p, RUNS) };
    const g = JSON.parse(after.cat)[0];
    const shown = await toasts(p);
    check('GI5.1 edit refused with the storage message while the runs cannot be read', () =>
      assert.deepEqual(shown, [['Not saved', UNREADABLE]]));
    check('GI5.2 no maintenance baseline corruption: lastServiceHourMeter stays 200, initial meter 100, name unchanged', () => {
      assert.deepEqual(g.serviceItems.filter((i) => i.enabled).map((i) => i.lastServiceHourMeter), [200, 200, 200, 200]);
      assert.deepEqual([g.initialHourMeter, g.name], [100, 'Gen A']);
    });
    check('GI5.3 the corrupt runs value and the catalog stay byte-for-byte', () => assert.deepEqual(after, before));
    await p.selectOption('#gen-name', 'id_g'); await p.waitForTimeout(250);
    await fillRun(p, 'id_g', '2026-09-25T08:00', '2026-09-25T09:00', 100.5);
    await clearToasts(p);
    await click(p, '#btnSubmitGen'); await waitIdle([p]);
    const runTry = { toasts: await toasts(p), cat: await raw(p, CAT), runs: await raw(p, RUNS) };
    check('GI5.4 a run over unreadable runs is refused too; nothing written', () =>
      assert.deepEqual(runTry, { toasts: [['Not saved', UNREADABLE]], cat: before.cat, runs: before.runs }));
    check('GI5.5 zero console errors', () => assert.deepEqual(errors, []));
    await context.close();
  });

  /* ---------- GI6 / GI7. missing runs key, valid [] runs: first use still works ---------- */
  for (const [tag, runsSeed] of [['GI6', undefined], ['GI7', '[]']]) {
    await scenario(tag, async () => {
      const seed = Object.assign({ [CAT]: [gen('id_g', 'Gen A', 100, 100)] }, runsSeed === undefined ? {} : { [RUNS]: runsSeed });
      const { context, pages: [p], errors } = await openTabs(browser, { seed });
      const label = runsSeed === undefined ? 'runs key missing' : 'runs = []';
      await openEdit(p, 'id_g', 'Gen First');
      const editable = await p.$eval('#genmgr-meter', (e) => !e.readOnly);
      await clearToasts(p); await click(p, '#genmgrSaveBtn'); await waitIdle([p]);
      const edited = (await ls(p, CAT))[0];
      const t1 = await toasts(p);
      await fillRun(p, 'id_g', '2026-09-25T08:00', '2026-09-25T09:00', 101);
      await clearToasts(p); await click(p, '#btnSubmitGen'); await waitIdle([p]);
      const runs = await ls(p, RUNS);
      const t2 = await toasts(p);
      check(`${tag}.1 ${label}: Edit works as for a generator with no history (meter editable, baselines = setup meter)`, () => {
        assert.equal(editable, true);
        assert.deepEqual(t1, [['Generator updated', '']]);
        assert.deepEqual([edited.name, edited.initialHourMeter, edited.serviceItems.filter((i) => i.enabled).map((i) => i.lastServiceHourMeter)],
          ['Gen First', 100, [100, 100, 100, 100]]);
      });
      check(`${tag}.2 ${label}: the first run is saved`, () => {
        assert.deepEqual(t2, [['Saved', 'Record saved on this device.']]);
        assert.deepEqual(runs.map((r) => [r.startHourMeter, r.endHourMeter]), [[100, 101]]);
      });
      check(`${tag}.3 zero console errors`, () => assert.deepEqual(errors, []));
      await context.close();
    });
  }

  /* ---------- GI8. runtime plausibility cases; blocked ones change nothing ---------- */
  await scenario('GI8', async () => {
    const { context, pages: [p], errors } = await openTabs(browser, { seed: { [CAT]: [gen('id_g', 'Gen A', 1000, 1000)] } });
    const cases = [
      ['elapsed 24 h, meter +100 -> BLOCK', '2026-09-20T08:00', '2026-09-21T08:00', 1100, false],
      ['elapsed 24 h, meter +24 -> PASS', '2026-09-20T08:00', '2026-09-21T08:00', 1024, true],
      ['elapsed 24 h, meter +10 -> PASS', null, '2026-09-22T08:00', 1034, true],
      ['elapsed 5 h, meter +7 -> BLOCK', null, '2026-09-22T13:00', 1041, false],
      ['elapsed 10 h, meter +10.10 -> PASS', null, '2026-09-22T18:00', 1044.1, true],
      ['elapsed 10 h, meter +10.20 -> BLOCK', null, '2026-09-23T04:00', 1054.3, false]];
    for (const [label, start, end, hm, pass] of cases) {
      const before = { cat: await raw(p, CAT), runs: await raw(p, RUNS) };
      await fillRun(p, 'id_g', start, end, hm);
      await clearToasts(p); await click(p, '#btnSubmitGen'); await waitIdle([p]);
      const after = { cat: await raw(p, CAT), runs: await raw(p, RUNS) };
      const err = await p.$eval('#err-gen-end-hm', (e) => [e.classList.contains('show'), e.textContent]);
      const shown = await toasts(p);
      check(`GI8 ${label}`, () => {
        if (pass) {
          assert.deepEqual(shown, [['Saved', 'Record saved on this device.']]);
          assert.equal(JSON.parse(after.runs).slice(-1)[0].endHourMeter, hm);
        } else {
          assert.deepEqual(err, [true, RUNTIME]);
          assert.deepEqual(after, before, 'a blocked run changed stored data');
        }
      });
    }
    check('GI8 zero console errors', () => assert.deepEqual(errors, []));
    await context.close();
  });

  /* ---------- GI9. no Web Locks: every Generator write refused, nothing written ---------- */
  await scenario('GI9', async () => {
    const { context, pages: [p], errors } = await openTabs(browser, { seed: SEED_G, noLocks: true });
    const before = { cat: await raw(p, CAT), runs: await raw(p, RUNS) };
    const out = {};
    await fillRun(p, 'id_g', '2026-09-25T08:00', '2026-09-25T09:00', 101, ['engine_oil']);
    await clearToasts(p); await click(p, '#btnSubmitGen'); await p.waitForTimeout(400); out.run = await toasts(p);
    await openEdit(p, 'id_g', 'Gen Renamed');
    await clearToasts(p); await click(p, '#genmgrSaveBtn'); await p.waitForTimeout(400); out.edit = await toasts(p);
    await p.click('#genmgrCancelBtn'); await p.waitForTimeout(150);
    await p.click('#genmgrAddBtn'); await p.waitForTimeout(200);
    await p.fill('#genmgr-name', 'Gen B'); await p.fill('#genmgr-size', '100 kVA'); await p.fill('#genmgr-meter', '5');
    for (const t of ['engine_oil', 'oil_filter', 'primary_fuel_filter', 'air_filter']) await p.fill('#genmgr-int-' + t, '100');
    await p.fill('#genmgr-fuel-rate', '5');
    await clearToasts(p); await click(p, '#genmgrSaveBtn'); await p.waitForTimeout(400); out.add = await toasts(p);
    await p.click('#genmgrCancelBtn'); await p.waitForTimeout(150);
    await openDelete(p, 'id_g');
    await clearToasts(p); await click(p, confirmDelete('id_g')); await p.waitForTimeout(400);
    out.archive = await toasts(p);
    const after = { cat: await raw(p, CAT), runs: await raw(p, RUNS) };
    check('GI9.1 without navigator.locks: run, edit, add and delete are refused with the existing Not saved message', () => {
      assert.deepEqual([out.run, out.edit, out.add], [[['Not saved', NOT_SAVED]], [['Not saved', NOT_SAVED]], [['Not saved', NOT_SAVED]]]);
      assert.deepEqual(out.archive, [['Not saved', 'Device storage is full or unavailable.']]);
    });
    check('GI9.2 nothing written: catalog and runs unchanged', () => assert.deepEqual(after, before));
    check('GI9.3 zero console errors', () => assert.deepEqual(errors, []));
    await context.close();
  });
}

(async () => {
  await part1();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  try { await part2(browser); } finally { await browser.close(); server.close(); }
  const out = path.join(process.env.RESULTS_DIR ? path.resolve(process.env.RESULTS_DIR) : os.tmpdir(),
    process.env.TEST_HTML ? 'generator-integrity-results-alt.json' : 'generator-integrity-results.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log('results: ' + out);
  console.log(`PASS ${results.pass.length}  FAIL ${results.fail.length}`);
  results.fail.forEach((f) => console.log('FAIL', f));
  process.exitCode = results.fail.length ? 1 : 0;
})();
