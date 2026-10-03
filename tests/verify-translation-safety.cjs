/* Translation safety: the language behaviour of the app after translation
   consolidation. Every check is REQUIRED; any failure fails the run.

   The architecture it protects: UI copy has explicit bilingual ownership
   (data-auth-en / -ar, data-auth-text-*, data-auth-placeholder-* / -alt-* /
   -label-*, rendered by applyAuthLanguage(); genmgrText() / openingText() for
   script-built UI); user and business data is shown exactly as stored
   (translate="no", shadow roots, option labels); a validation error keeps a
   stable reason key across a language switch. The legacy text-replacement
   translators were removed in phase 3; the ARCH checks fail if they, or
   delayed translation passes, come back.

   RESOLVED_DEBT keeps the defects found before consolidation traceable
   (phases 1 and 2): each is a REQUIRED invariant, evaluated once per run.
   The run also fails on any UNEXPECTED CHANGE: a harness or runtime error,
   an unregistered id, or a registered one that was never evaluated.

   Every scenario runs in its own browser context with seeded, deterministic
   data, and closes it afterwards. The app is served as a static site; any
   other request is counted as a backend request and aborted. The page clock
   is paused (Playwright clock) and advanced by SETTLE_MS after each switch,
   past the 900 ms the removed passes used to wait, so "immediately" and
   "after any delayed work" are exact states, not races. No screenshots:
   text, attributes, values, storage and visibility only.

   Run from the repository root: node tests/verify-translation-safety.cjs
   PLAYWRIGHT_CORE=<path to playwright-core> loads it from there; otherwise
   playwright-core (or playwright) is found by normal Node resolution
   (a node_modules folder above this file, or NODE_PATH).
   RESULTS_DIR=<dir> receives the results JSON (default: the OS temp directory,
   so nothing is written inside the repository).
   TEST_HTML=<file> serves that file as index.html.
   ONLY=L1,E1,... runs just those scenarios. */
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
// Past the longest delay the removed legacy passes used (900 ms): anything
// still scheduled after a switch or a load would show up within it.
const SETTLE_MS = 1500;

/* ======================= RESOLVED_DEBT (REQUIRED) =======================
   Defects confirmed by the characterization run before consolidation and
   corrected in translation consolidation phases 1 and 2. Kept for
   traceability: each is a REQUIRED invariant, evaluated exactly once by the
   scenario in `where`. */
const RESOLVED_DEBT = {
  // Phase 2
  'T-PH-01': { where: 'P1', invariant: 'the end hour meter placeholder is "e.g. 1251.2" in English and "مثال: 1251.2" in Arabic, through a round trip',
    was: 'stayed "e.g. 1251.2" under Arabic' },
  'T-OPT-01': { where: 'O1', invariant: 'Attendance type options display Arabic labels under Arabic and English ones again under English; values stay IN, OUT, BREAK OUT, BREAK IN',
    was: 'displayed IN, OUT, BREAK OUT, BREAK IN under Arabic' },
  'T-ALT-01': { where: 'I1', invariant: 'image preview alt text follows the language, for previews made before and after a switch, with the right number',
    was: 'stayed "Selected photo 1" under Arabic' },
  'T-RT-01': { where: 'RT', invariant: 'the NOW buttons read "NOW" again after EN -> AR -> EN',
    was: 'came back as "Now"' },
  'T-RT-02': { where: 'RT', invariant: 'card titles return to their source text after EN -> AR -> EN',
    was: 'came back as upper-case text ("TASK DETAILS")' },
  'T-RT-03': { where: 'RT', invariant: 'placeholders keep their ellipsis "…" after EN -> AR -> EN',
    was: 'came back with "..."' },
  'T-TIME-01': { where: 'TM', invariant: 'no UI string changes after the moment of a switch or a page load: nothing waits for a delayed pass',
    was: '98 strings each way became correct only through the delayed passes; the Purchase button read "إرسال Purchase Request" until its pass' },
  // Phase 1
  'T-DISPLAY-01': { where: 'U1', invariant: 'the user bar shows the username exactly as stored, in both languages, through repeated switching',
    was: 'username "Operating Hours" was shown as "ساعات التشغيل" under Arabic' },
  'T-DISPLAY-02': { where: 'U1', invariant: 'employee option "Now" shows "Now" in both languages, through repeated switching',
    was: 'shown as "الآن" under Arabic and "NOW" back in English' },
  'T-DISPLAY-03': { where: 'U1', invariant: 'employee option "Now Generator" shows "Now Generator" in both languages, through repeated switching',
    was: 'shown as "الآن Generator" under Arabic and "NOW Generator" back in English' },
  'T-DISPLAY-04': { where: 'U1', invariant: 'Arabic employee names ("الآن", "ساعات التشغيل") show exactly, on an English load and through repeated switching',
    was: 'shown as "NOW" and "Operating Hours" on a plain English load' },
  'T-ERROR-01': { where: 'E1', invariant: 'a shown validation reason (end before start) keeps its identity through a language switch, worded in the new language',
    was: 'a switch replaced it with the required-field message ("تاريخ ووقت النهاية مطلوب" / "End date & time is required")' },
  'T-SESSION-01': { where: 'S1', invariant: 'the user bar is identical, with the exact username, whether the session starts at page load, is restored, or starts once the page has settled',
    was: 'translated ("ساعات التشغيل") in the first two cases, raw only when login came after the legacy page-load passes' }
};

/* ======================= results ======================= */
const R = { requiredPass: [], requiredFail: [], unexpected: [], info: [] };
const evaluatedResolved = new Set();
function req(name, fn) {
  try { fn(); R.requiredPass.push(name); } catch (e) { R.requiredFail.push(`${name} :: ${e.message.split('\n').slice(0, 12).join('\n')}`); }
}
// A former debt, now a REQUIRED invariant: a failure is a REQUIRED FAIL.
function resolved(id, holds, actual) {
  const entry = RESOLVED_DEBT[id];
  if (!entry) { R.unexpected.push(`unregistered RESOLVED_DEBT id ${id}`); return; }
  if (evaluatedResolved.has(id)) { R.unexpected.push(`RESOLVED_DEBT ${id} evaluated twice`); return; }
  evaluatedResolved.add(id);
  req(`${id} ${entry.invariant}`, () => assert.ok(holds, `${actual} (formerly: ${entry.was})`));
}
const info = (line) => R.info.push(line);
const want = (tag) => !process.env.ONLY || process.env.ONLY.split(',').includes(tag);
async function scenario(tag, body) {
  if (!want(tag)) return;
  try { await body(); } catch (e) { R.unexpected.push(`${tag} harness :: ${String((e && e.message) || e).split('\n')[0]}`); }
}

/* ======================= pure helpers (also self-tested in H) ======================= */
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// Adjacent repeated word, e.g. "Now Now" or "الآن الآن".
const duplicatedWord = (s) => /(^|\s)(\S+)\s+\2(?=\s|$)/u.test(norm(s));
function diffSnap(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).map((k) => ({ key: k, before: a[k], after: b[k] }));
}
// Round-trip differences that belong to a registered debt, by exact shape.
const RT_DEBT = [
  ['T-RT-01', (d) => norm(d.before) === 'NOW' && norm(d.after) === 'Now'],
  ['T-RT-02', (d) => norm(d.before) !== norm(d.after) && norm(d.before).toUpperCase() === norm(d.after)],
  ['T-RT-03', (d) => String(d.before).includes('…') && String(d.before).replace(/…/g, '...') === d.after]
];
const END_BEFORE_START = { en: 'End time cannot be before start time', ar: 'وقت النهاية لا يمكن أن يسبق وقت البداية' };
const END_REQUIRED = { en: 'End date & time is required', ar: 'تاريخ ووقت النهاية مطلوب' };
// The Generator form's cross-field reasons, by the app's own reason keys.
const GEN_REASONS = {
  runtime_exceeds_elapsed: { en: 'Operating hours cannot exceed the elapsed time between start and end. Check the hour-meter readings.',
    ar: 'ساعات التشغيل لا يمكن أن تتجاوز المدة بين وقت البداية والنهاية. تحقق من قراءات عداد المولد.' },
  end_reading_below_start: { en: 'End reading cannot be less than start reading', ar: 'قراءة النهاية لا يمكن أن تقل عن قراءة البداية' },
  end_before_start: END_BEFORE_START,
  end_not_after_start: { en: 'End time must be after start time', ar: 'يجب أن يكون وقت النهاية بعد وقت البداية' }
};
// Validation-error identity, independent of the wording language.
function errorIdentity(text) {
  const t = norm(text);
  if (t === END_BEFORE_START.en || t === END_BEFORE_START.ar) return 'end-before-start';
  if (t === END_REQUIRED.en || t === END_REQUIRED.ar) return 'end-required';
  return 'other: ' + t;
}

/* ======================= the removed legacy architecture (phase 3) ======================= */
const LEGACY_TRANSLATORS = ['applySmallTitleTranslation', 'applySmallPlaceholderTranslation', 'applySmallButtonTranslation',
  'applyFinalLanguageFix', 'applyMixedLanguageCleanup', 'applyFuelLanguage', 'fixPurchaseButtonLanguage'];
// Their initializers, delayed refresh closures and shared helper.
const LEGACY_HELPERS = ['initSmallTitleTranslation', 'initSmallPlaceholderTranslation', 'initSmallButtonTranslation',
  'initFinalLanguageFix', 'initMixedLanguageCleanup', 'initFuelLanguage', 'initPurchaseButtonFinalFix',
  'refreshTitleLanguage', 'refreshPlaceholderLanguage', 'refreshButtonLanguage', 'refreshFinalLanguage', 'refreshCleanup',
  'refreshFuelLanguage', 'refreshPurchaseButton', 'legacyTranslatable'];
// Entries found only in their text-replacement tables.
const LEGACY_TABLE_ENTRIES = ['TASK DETAILS', 'Purchase Request إرسال', 'Use Now', 'Submit Purchase Order', '#nav-fuel'];
// Every deferred callback in a source (timers, idle / frame callbacks,
// MutationObserver), with its line and whether it runs translation code:
// a name containing Lang, Translat or Cleanup (applyAuthLanguage,
// refreshFuelLanguage, ...), called or passed by reference. A callback that
// cannot be parsed counts as translating.
function deferredCallbacks(source) {
  const api = /\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|MutationObserver)\s*\(/g;
  const out = [];
  let m;
  while ((m = api.exec(source))) {
    const args = balancedArgs(source, m.index + m[0].length);
    out.push({ api: m[1], line: source.slice(0, m.index).split('\n').length, args,
      translates: args === null || /\b\w*(?:Lang|Translat|Cleanup)\w*\b/.test(args) });
  }
  return out;
}
// The text from `start` to the parenthesis that closes the one just before
// it, skipping strings and comments; null if it never closes.
function balancedArgs(source, start) {
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && (c === '`' || source[j] !== '\n')) j += source[j] === '\\' ? 2 : 1;
      if (source[j] !== c) return null;
      i = j;
    } else if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return null;
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      if (i < 1) return null;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return source.slice(start, i);
  }
  return null;
}

/* ======================= test data ======================= */
const iso = (s) => new Date(s).toISOString();
const gen = (id, name, size, meter) => ({ id, name, size, initialHourMeter: meter, fuelConsumptionPerHour: 20,
  serviceItems: ['engine_oil', 'oil_filter', 'primary_fuel_filter', 'air_filter']
    .map((type) => ({ type, enabled: true, intervalHours: 250, lastServiceHourMeter: meter }))
    .concat(['secondary_fuel_filter', 'water_separator_filter'].map((type) => ({ type, enabled: false, intervalHours: null, lastServiceHourMeter: null }))),
  createdAt: iso('2026-09-20T08:00:00Z'), updatedAt: iso('2026-09-20T08:00:00Z'), active: true, archivedAt: null });
const tank = (id, name, capacity) => ({ id, name, capacityLitres: capacity, createdAt: iso('2026-09-20T08:00:00Z'),
  updatedAt: iso('2026-09-20T08:00:00Z'), active: true, archivedAt: null });
const reading = (id, tankId, at, litres, notes) => ({ id, tankId, effectiveAt: iso(at), measuredLitres: litres,
  previousReadingId: null, calculatedConsumption: null, notes, createdAt: iso(at) });
const move = (id, from, to, quantity, at, notes) => ({ id, movementType: 'tank_transfer', sourceType: 'tank', sourceId: from,
  destinationType: 'tank', destinationId: to, quantityLitres: quantity, effectiveAt: iso(at), notes, createdAt: iso(at) });
const user = (username) => ({ username, employeeName: username, role: 'Admin' });

// Business values that look like UI vocabulary, in both languages.
const SEED_BUSINESS = {
  genops_generator_catalog_v1: [gen('id_g1', 'Now Generator', 'Operating Hours', 100), gen('id_g2', 'الآن مولدة', 'حفظ مشروع', 50)],
  genops_generator_runs_v1: [{ id: 'id_r1', generatorId: 'id_g1', startDateTime: '2026-09-24T08:00', startHourMeter: 100,
    endDateTime: '2026-09-24T10:00', endHourMeter: 102, operatingHours: 2, servicesPerformed: [], createdAt: iso('2026-09-24T07:00:00Z') }],
  genops_fuel_tanks_v1: [tank('id_t1', 'Fuel Tank', 1000), tank('id_t2', 'خزان الوقود', 1000)],
  genops_fuel_readings_v1: [reading('id_rd1', 'id_t1', '2026-09-24T06:00:00Z', 500, 'Note'),
    reading('id_rd2', 'id_t2', '2026-09-24T06:00:00Z', 200, 'ملاحظة')],
  genops_fuel_movements_v1: [move('id_m1', 'id_t1', 'id_t2', 10, '2026-09-24T07:00:00Z', 'Save Project'),
    move('id_m2', 'id_t2', 'id_t1', 5, '2026-09-24T08:00:00Z', 'حفظ مشروع')]
};
// The prototype username of the data scenarios: once rewritten under Arabic.
const SESSION_NAME = 'Operating Hours';
const VOCAB_EMPLOYEES = ['Now', 'NOW', 'Now Generator', 'Operating Hours', 'Employee & Time', 'IN', 'Selected photo 1', 'Select employee',
  'Save', 'English', 'الآن', 'العربية', 'Mukhtar Mohammed'];
const VOCAB_FORM = { 'task-name': 'Now Generator', 'task-desc': 'Operating Hours\nساعات التشغيل', 'po-desc': 'Save Project',
  'po-purpose': 'Select employee / اختر الموظف', 'po-qty': '4', 'po-cost': '250', 'fuel-note': 'Note ملاحظة', 'gen-end-hm': '103' };
const VOCAB_SELECT = { 'gen-name': 'id_g1', 'fuel-tank': 'id_t1', 'task-employee': 'Now', 'att-employee': 'Now Generator',
  'po-requester': 'الآن', 'att-type': 'BREAK OUT' };
const VOCAB_EDITOR = { 'genmgr-name': 'Delete', 'genmgr-size': 'لتر', 'fuelmgr-tank-name': 'English', 'fuelmgr-tank-capacity': '750' };
// Generator / Tank names for the modern UI (section 13).
const SEED_NAMES = {
  genops_generator_catalog_v1: [gen('id_g1', 'Now Generator', '250 kVA', 100), gen('id_g2', 'Fuel', 'Operating Hours', 40)],
  genops_generator_runs_v1: [],
  genops_fuel_tanks_v1: [tank('id_t1', 'Operating Hours', 1000), tank('id_t2', 'ساعات التشغيل', 1000)],
  genops_fuel_readings_v1: [reading('id_rd1', 'id_t1', '2026-09-24T06:00:00Z', 500, ''), reading('id_rd2', 'id_t2', '2026-09-24T06:00:00Z', 200, '')],
  // The movement id is system data shown in the Fuel log; "Fuel" is also a Fuel-section UI word.
  genops_fuel_movements_v1: [move('Fuel', 'id_t1', 'id_t2', 10, '2026-09-24T07:00:00Z', 'Now')]
};

/* ======================= static server ======================= */
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = rel === 'index.html' ? HTML : path.join(ROOT, rel);
  if ((!file.startsWith(ROOT) && file !== HTML) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
const origin = () => `http://127.0.0.1:${server.address().port}`;
const isStatic = (url, method) => {
  if (method !== 'GET' || !url.startsWith(origin() + '/')) return false;
  const rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '') || 'index.html';
  const file = rel === 'index.html' ? HTML : path.join(ROOT, rel);
  return (file.startsWith(ROOT) || file === HTML) && fs.existsSync(file) && !fs.statSync(file).isDirectory();
};

/* ======================= page-side helpers (test only) ======================= */
// Runs in every document before the app: seeds storage once per context,
// optionally replaces the demo employee list, and exposes read-only probes.
function pageInit(a) {
  if (!localStorage.getItem('__seeded')) {
    Object.keys(a.seed).forEach((k) => localStorage.setItem(k, typeof a.seed[k] === 'string' ? a.seed[k] : JSON.stringify(a.seed[k])));
    localStorage.setItem('__seeded', '1');
  }
  if (a.employees) {
    let config;
    Object.defineProperty(window, 'CONFIG', { configurable: true, get() { return config; },
      set(value) { if (value && Array.isArray(value.DEFAULT_EMPLOYEES)) value.DEFAULT_EMPLOYEES = a.employees.slice(); config = value; } });
  }
  const keyOf = (el) => {
    const parts = [];
    while (el && el !== document.body && el.parentNode) {
      if (el.id) { parts.unshift('#' + el.id); break; }
      parts.unshift(el.tagName.toLowerCase() + ':' + Array.prototype.indexOf.call(el.parentNode.children, el));
      el = el.parentNode;
    }
    return parts.join('>');
  };
  const shadowText = (el) => (el.shadowRoot ? el.shadowRoot.textContent : el.textContent);
  window.__tr = {
    // Every UI text node and text attribute in the document (toasts excluded).
    snap() {
      const out = {};
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script, style, #toastStack') || !node.nodeValue.trim()) continue;
        out[keyOf(parent) + '/t' + Array.prototype.indexOf.call(parent.childNodes, node)] = node.nodeValue;
      }
      document.querySelectorAll('[placeholder], [aria-label], [alt], [title], option[label]').forEach((el) => {
        if (el.closest('#toastStack')) return;
        ['placeholder', 'aria-label', 'alt', 'title', 'label'].forEach((attr) => {
          if (el.hasAttribute(attr)) out[keyOf(el) + '@' + attr] = el.getAttribute(attr);
        });
      });
      return out;
    },
    // Explicitly owned UI copy not showing its data-auth-*-<lang> wording:
    // whole-element text, an element's own text beside its children, and
    // placeholder / alt / option label attributes.
    explicitMismatches(lang) {
      const out = Array.from(document.querySelectorAll('[data-auth-en][data-auth-ar]'))
        .filter((el) => el.textContent !== el.getAttribute('data-auth-' + lang))
        .map((el) => keyOf(el) + ' = ' + JSON.stringify(el.textContent));
      document.querySelectorAll('[data-auth-text-en][data-auth-text-ar]').forEach((el) => {
        const own = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim());
        if (!own || own.nodeValue.trim() !== el.getAttribute('data-auth-text-' + lang)) out.push(keyOf(el) + ' own text = ' + JSON.stringify(own && own.nodeValue));
      });
      ['placeholder', 'alt', 'label'].forEach((attr) => document.querySelectorAll(`[data-auth-${attr}-en][data-auth-${attr}-ar]`).forEach((el) => {
        if (el.getAttribute(attr) !== el.getAttribute(`data-auth-${attr}-${lang}`)) out.push(keyOf(el) + '@' + attr + ' = ' + JSON.stringify(el.getAttribute(attr)));
      }));
      return out;
    },
    explicitTotal: () => ['[data-auth-en][data-auth-ar]', '[data-auth-text-en][data-auth-text-ar]', '[data-auth-placeholder-en]', '[data-auth-alt-en]', '[data-auth-label-en]']
      .reduce((n, sel) => n + document.querySelectorAll(sel).length, 0),
    // UI copy in these roots that nothing translates: text with letters, or
    // a placeholder with letters, outside explicit ownership, raw data
    // (translate="no") and shadow roots.
    unowned(selectors) {
      const out = [];
      const letters = /[A-Za-z؀-ۿ]/;
      const owned = '[data-auth-en], [data-auth-text-en], [data-auth-label-en], [translate="no"]';
      document.querySelectorAll(selectors).forEach((root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (letters.test(node.nodeValue) && !node.parentElement.closest(owned)) out.push(keyOf(node.parentElement) + ' = ' + JSON.stringify(node.nodeValue.trim()));
        }
        root.querySelectorAll('[placeholder]').forEach((el) => {
          if (letters.test(el.getAttribute('placeholder')) && !el.hasAttribute('data-auth-placeholder-en')) out.push(keyOf(el) + '@placeholder = ' + JSON.stringify(el.getAttribute('placeholder')));
        });
      });
      return out;
    },
    explicitCount: (root) => (root || document).querySelectorAll('[data-auth-en][data-auth-ar]').length,
    explicitMismatchesIn(selector, lang) {
      return Array.from(document.querySelectorAll(selector)).flatMap((root) =>
        Array.from(root.querySelectorAll('[data-auth-en][data-auth-ar]')).concat(root.matches('[data-auth-en][data-auth-ar]') ? [root] : []))
        .filter((el) => el.textContent !== el.getAttribute('data-auth-' + lang))
        .map((el) => keyOf(el) + ' = ' + JSON.stringify(el.textContent));
    },
    controls() {
      const out = {};
      document.querySelectorAll('input, textarea, select').forEach((el) => {
        if (el.id && el.type !== 'file') out[el.id] = el.type === 'checkbox' ? String(el.checked) : el.value;
      });
      return out;
    },
    options() {
      const out = {};
      document.querySelectorAll('select').forEach((select) => {
        out[select.id] = Array.from(select.options).map((o) => ({ value: o.value, label: o.label, text: o.textContent }));
      });
      return out;
    },
    storage() {
      const out = {};
      Object.keys(localStorage).sort().forEach((k) => { if (k.startsWith('genops_')) out[k] = localStorage.getItem(k); });
      return out;
    },
    // User-entered names as the modern Generator / Fuel UI shows them.
    names() {
      const all = (sel) => Array.from(document.querySelectorAll(sel));
      return {
        generatorCards: all('#generatorOverviewList .genmgr-ov-name, #generatorOpsList .genmgr-ov-name').map(shadowText),
        generatorSizes: all('#generatorOverviewList .genmgr-ov-size, #generatorOpsList .genmgr-ov-size').map(shadowText),
        tankCards: all('#fuelTankList .fuelmgr-name, #fuelOverviewList .fuelmgr-name').map(shadowText),
        movementRoutes: all('.fuelmgr-move-route').map((r) => Array.from(r.children).filter((c) => c.shadowRoot).map(shadowText)),
        movementNotes: all('.fuelmgr-move-notes').map(shadowText),
        // The movement id (last span of the meta line) and its raw-data marker.
        movementIds: all('.fuelmgr-move-meta > span:last-of-type').map((s) => [s.textContent, s.getAttribute('translate')]),
        generatorOptions: all('#gen-name option').filter((o) => o.value).map((o) => o.label),
        tankOptions: all('#fuel-tank option').filter((o) => o.value).map((o) => o.label)
      };
    },
    text: (selector) => { const el = document.querySelector(selector); return el ? el.textContent : null; },
    attr: (selector, name) => { const el = document.querySelector(selector); return el ? el.getAttribute(name) : null; },
    visible: (selector) => { const el = document.querySelector(selector); return !!el && el.checkVisibility({ visibilityProperty: true }); },
    lang: () => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, stored: localStorage.getItem('genops_language'),
      bodyDirection: getComputedStyle(document.body).direction,
      activeButton: document.getElementById('btnLangAr').classList.contains('active') ? 'ar'
        : document.getElementById('btnLangEn').classList.contains('active') ? 'en' : 'none' })
  };
}

/* ======================= browser harness ======================= */
async function open(browser, o) {
  const opts = Object.assign({ lang: 'en', session: null, seed: {}, employees: null, settle: true }, o);
  const seed = Object.assign({ genops_language: opts.lang }, opts.session ? { genops_prototype_user: opts.session } : {}, opts.seed);
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block',
    timezoneId: 'Asia/Baghdad', locale: 'en-US' });
  const backend = [];
  await context.route('**/*', (route) => {
    const request = route.request();
    if (isStatic(request.url(), request.method())) return route.continue();
    backend.push(request.method() + ' ' + request.url());
    return route.abort();
  });
  await context.addInitScript(pageInit, { seed, employees: opts.employees });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  // Paused from the start: timers fire only through settle().
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(new Date(NOW.getTime() + 1000));
  await page.goto(origin() + '/index.html', { waitUntil: 'load' });
  const h = {
    context, page, errors, backend,
    settle: () => page.clock.runFor(SETTLE_MS),
    ev: (fn, arg) => page.evaluate(fn, arg),
    tr: (name, ...args) => page.evaluate(([n, a]) => window.__tr[n](...a), [name, args]),
    click: (selector) => page.evaluate((s) => document.querySelector(s).click(), selector),
    // Clicks the language button the way the menu does; `immediate` is the
    // snapshot taken in the same task, before any delayed pass could run.
    async switchTo(lang, settle = true) {
      const immediate = await page.evaluate((l) => {
        document.getElementById(l === 'ar' ? 'btnLangAr' : 'btnLangEn').click();
        return window.__tr.snap();
      }, lang);
      if (settle) await page.clock.runFor(SETTLE_MS);
      return immediate;
    },
    async reload() { await page.reload({ waitUntil: 'load' }); },
    async until(predicate, arg, what) {
      for (let i = 0; i < 300; i++) {
        if (await page.evaluate(predicate, arg)) return;
        await page.waitForTimeout(20);
      }
      throw new Error('timed out waiting for ' + what);
    },
    // Sets a control as a user would and lets the app react.
    async set(id, value) {
      await page.evaluate(([i, v]) => {
        const el = document.getElementById(i);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, [id, value]);
    },
    async login(username, passcode = '1') {
      await page.evaluate(([u, p]) => {
        document.getElementById('authUsername').value = u;
        document.getElementById('authPasscode').value = p;
        document.getElementById('authLoginButton').click();
      }, [username, passcode]);
    }
  };
  if (opts.settle) await h.settle();
  return h;
}
function cleanRun(tag, h) {
  req(`${tag} zero console errors / page errors`, () => assert.deepEqual(h.errors, []));
  req(`${tag} zero application backend requests (static same-origin files only)`, () => assert.deepEqual(h.backend, []));
}
const NAV = [ // id, page, en, ar, in the quick bar
  ['home', 'home', 'Overview', 'نظرة عامة', true], ['ops', 'generators', 'Ops', 'تشغيلي', true],
  ['tasks', 'tasks', 'Tasks', 'المهام', true], ['supply', 'purchase', 'Supply', 'الإمداد', true],
  ['projects', 'projects', 'Projects', 'المشاريع', false], ['management', 'attendance', 'Management', 'الإدارة', true],
  ['reports', 'reports', 'Reports', 'التقارير', false], ['users', 'users', 'Users', 'المستخدمون', false],
  ['settings', 'settings', 'Settings', 'الإعدادات', false]];
async function navState(h) {
  return h.ev((nav) => ({
    drawer: nav.map(([id]) => document.querySelector('#drawer-' + id + ' .nav-label').textContent),
    quick: nav.filter((n) => n[4]).map(([, page]) => document.querySelector('#nav-' + page + ' .nav-label').textContent),
    ids: Array.from(document.querySelectorAll('#drawerNav [data-page], #quickNav [data-page]')).map((b) => b.id + '=' + b.dataset.page),
    title: document.getElementById('drawerTitle').textContent,
    overview: document.getElementById('nav-title-home').textContent,
    aria: ['menuToggle', 'drawerNav', 'quickNav'].map((id) => document.getElementById(id).getAttribute('aria-label'))
  }), NAV);
}
function expectedNav(lang) {
  const i = lang === 'ar' ? 3 : 2;
  return { drawer: NAV.map((n) => n[i]), quick: NAV.filter((n) => n[4]).map((n) => n[i]),
    title: lang === 'ar' ? 'القائمة' : 'Menu', overview: lang === 'ar' ? 'نظرة عامة' : 'Overview',
    aria: lang === 'ar' ? ['فتح القائمة', 'التنقّل الرئيسي', 'التنقّل السريع'] : ['Open menu', 'Main navigation', 'Quick navigation'] };
}

/* ======================= scenarios ======================= */
async function run(browser) {
  /* ---------- H. the harness detects the defects it reports ---------- */
  await scenario('H', async () => {
    req('H duplicate-word detector flags "Now Now" and "الآن الآن", not "Now Generator"', () => {
      assert.deepEqual([duplicatedWord('Now Now'), duplicatedWord('x الآن الآن y'), duplicatedWord('Now Generator')], [true, true, false]);
    });
    req('H round-trip classifier: NOW->Now is T-RT-01, Task Details->TASK DETAILS is T-RT-02, …->... is T-RT-03, other drift is unregistered', () => {
      const cls = (before, after) => (RT_DEBT.find(([, m]) => m({ before, after })) || ['none'])[0];
      assert.deepEqual([cls('NOW', 'Now'), cls('\n Task Details\n', '\n TASK DETAILS\n'), cls('Select type…', 'Select type...'), cls('Tasks', 'Task')],
        ['T-RT-01', 'T-RT-02', 'T-RT-03', 'none']);
    });
    req('H validation identity is independent of wording language; a different reason is detected', () => {
      assert.deepEqual([errorIdentity(END_BEFORE_START.en), errorIdentity(END_BEFORE_START.ar), errorIdentity(END_REQUIRED.ar)],
        ['end-before-start', 'end-before-start', 'end-required']);
    });
    req('H deferred-callback classifier flags delayed translation (by reference, by call, in an observer), not other timers', () => {
      const sample = 'setTimeout(refreshTitleLanguage, 60);\nsetTimeout(function () { applyAuthLanguage(); }, 0);\n' +
        "setTimeout(() => { el.classList.add('out'); /* ) */ setTimeout(() => el.remove(), 260); }, life);\n" +
        'new MutationObserver(() => applyFuelLanguage(lang));\nsetTimeout(() => { show(\'(\'';
      assert.deepEqual(deferredCallbacks(sample).map((d) => [d.api, d.line, d.translates]), [['setTimeout', 1, true], ['setTimeout', 2, true],
        ['setTimeout', 3, false], ['setTimeout', 3, false], ['MutationObserver', 4, true], ['setTimeout', 5, true]]);
    });
  });

  /* ---------- L1. language controller (section 6) ---------- */
  await scenario('L1', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester') });
    const states = { start: await h.tr('lang') };
    await h.switchTo('ar'); states.ar = await h.tr('lang');
    await h.switchTo('en'); states.en = await h.tr('lang');
    await h.switchTo('ar'); await h.reload(); await h.settle(); states.reloadAr = await h.tr('lang');
    await h.switchTo('en'); await h.reload(); await h.settle(); states.reloadEn = await h.tr('lang');
    const en = { lang: 'en', dir: 'ltr', stored: 'en', bodyDirection: 'ltr', activeButton: 'en' };
    const ar = { lang: 'ar', dir: 'rtl', stored: 'ar', bodyDirection: 'rtl', activeButton: 'ar' };
    req('L1 English: html lang=en, dir=ltr, genops_language=en, EN button active', () => assert.deepEqual(states.start, en));
    req('L1 EN -> AR: html lang=ar, dir=rtl (computed rtl), genops_language=ar, AR button active', () => assert.deepEqual(states.ar, ar));
    req('L1 AR -> EN: html lang=en, dir=ltr, genops_language=en', () => assert.deepEqual(states.en, en));
    req('L1 reload restores Arabic', () => assert.deepEqual(states.reloadAr, ar));
    req('L1 reload restores English', () => assert.deepEqual(states.reloadEn, en));
    cleanRun('L1', h);
    await h.context.close();
  });

  /* ---------- L2. initial load, both languages, with and without a session (section 7) ---------- */
  for (const lang of ['en', 'ar']) {
    for (const withSession of [false, true]) {
      const tag = 'L2';
      await scenario(tag, async () => {
        const label = `${lang.toUpperCase()} ${withSession ? 'restored session' : 'no session'}`;
        const h = await open(browser, { lang, session: withSession ? user('tester') : null });
        const state = await h.ev(() => ({
          login: window.__tr.visible('#authLoginScreen'), locked: document.documentElement.classList.contains('auth-locked'),
          overview: document.getElementById('page-home').classList.contains('active') && window.__tr.visible('#page-home'),
          userBar: window.__tr.visible('#authUserBar'), lang: window.__tr.lang(),
          loginTitle: window.__tr.text('.auth-login-title'), username: window.__tr.attr('#authUsername', 'placeholder')
        }));
        const nav = await navState(h);
        req(`L2 ${label}: ${withSession ? 'Overview shown, login hidden' : 'login shown, app locked'}`, () => assert.deepEqual(
          [state.login, state.locked, state.overview, state.userBar], withSession ? [false, false, true, true] : [true, true, false, false]));
        req(`L2 ${label}: lang/dir`, () => assert.deepEqual([state.lang.lang, state.lang.dir, state.lang.bodyDirection],
          lang === 'ar' ? ['ar', 'rtl', 'rtl'] : ['en', 'ltr', 'ltr']));
        req(`L2 ${label}: navigation labels, menu title and ARIA labels in ${lang.toUpperCase()}`, () => {
          const e = expectedNav(lang);
          assert.deepEqual([nav.drawer, nav.quick, nav.title, nav.overview, nav.aria], [e.drawer, e.quick, e.title, e.overview, e.aria]);
        });
        req(`L2 ${label}: login screen text and placeholder in ${lang.toUpperCase()}`, () => assert.deepEqual(
          [norm(state.loginTitle), state.username], lang === 'ar' ? ['مرحباً بعودتك', 'أدخل اسم المستخدم'] : ['Welcome back', 'Enter username']));
        cleanRun(`L2 ${label}`, h);
        await h.context.close();
      });
    }
  }

  /* ---------- D1. business / user data preserved by a round trip (section 9) ---------- */
  async function fillVocabulary(h) {
    for (const [id, value] of Object.entries(VOCAB_SELECT)) await h.set(id, value);
    await h.until(() => document.getElementById('gen-start-hm').value !== '' && document.getElementById('fuel-first-reading').value !== '', null, 'selection renders');
    for (const [id, value] of Object.entries(VOCAB_FORM)) await h.set(id, value);
    await h.click('#genmgrAddBtn');
    await h.until(() => !document.getElementById('genmgrEditor').hidden, null, 'generator editor');
    await h.click('#fuelmgrAddTankBtn');
    await h.until(() => !document.getElementById('fuelmgrTankEditor').hidden, null, 'tank editor');
    for (const [id, value] of Object.entries(VOCAB_EDITOR)) await h.set(id, value);
  }
  await scenario('D1', async () => {
    const h = await open(browser, { lang: 'en', session: user(SESSION_NAME), seed: SEED_BUSINESS, employees: VOCAB_EMPLOYEES });
    await fillVocabulary(h);
    const before = { storage: await h.tr('storage'), controls: await h.tr('controls'), options: await h.tr('options') };
    const stages = {};
    await h.switchTo('ar'); stages.AR = { storage: await h.tr('storage'), controls: await h.tr('controls'), options: await h.tr('options') };
    await h.switchTo('en'); stages.EN = { storage: await h.tr('storage'), controls: await h.tr('controls'), options: await h.tr('options') };
    const withoutLang = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'genops_language'));
    for (const [stage, now] of Object.entries(stages)) {
      for (const key of Object.keys(SEED_BUSINESS).concat(['genops_prototype_user'])) {
        req(`D1 after ${stage}: localStorage ${key} byte-identical`, () => assert.equal(now.storage[key], before.storage[key]));
      }
      req(`D1 after ${stage}: no other stored key added, removed or changed`, () => assert.deepEqual(withoutLang(now.storage), withoutLang(before.storage)));
      for (const [id, value] of Object.entries(Object.assign({}, VOCAB_FORM, VOCAB_SELECT, VOCAB_EDITOR))) {
        req(`D1 after ${stage}: #${id}.value stays ${JSON.stringify(value)}`, () => assert.equal(now.controls[id], value));
      }
      req(`D1 after ${stage}: all ${Object.keys(before.controls).length} form control values unchanged`, () => assert.deepEqual(now.controls, before.controls));
      req(`D1 after ${stage}: option.value lists of every select unchanged`, () => assert.deepEqual(
        Object.fromEntries(Object.entries(now.options).map(([k, v]) => [k, v.map((o) => o.value)])),
        Object.fromEntries(Object.entries(before.options).map(([k, v]) => [k, v.map((o) => o.value)]))));
    }
    req(`D1 the prototype session record is exactly what was stored ({"username":"${SESSION_NAME}",...})`, () =>
      assert.equal(stages.EN.storage.genops_prototype_user, JSON.stringify(user(SESSION_NAME))));
    cleanRun('D1', h);
    await h.context.close();
  });

  /* ---------- D2. ten EN -> AR -> EN cycles (section 8) ---------- */
  await scenario('D2', async () => {
    const h = await open(browser, { lang: 'en', session: user(SESSION_NAME), seed: SEED_BUSINESS, employees: VOCAB_EMPLOYEES });
    await fillVocabulary(h);
    const base = { storage: await h.tr('storage'), controls: await h.tr('controls'), options: await h.tr('options'), snap: await h.tr('snap') };
    const baseDup = Object.entries(base.snap).filter(([, v]) => duplicatedWord(v)).map(([k]) => k);
    const withoutLang = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'genops_language'));
    const values = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map((x) => x.value)]));
    let first = null;
    const problems = { storage: [], controls: [], options: [], lang: [], dup: [], drift: [], display: [] };
    for (let cycle = 1; cycle <= 10; cycle++) {
      const seen = {};
      for (const lang of ['ar', 'en']) {
        await h.switchTo(lang);
        const s = { storage: await h.tr('storage'), controls: await h.tr('controls'), options: await h.tr('options'), snap: await h.tr('snap'), lang: await h.tr('lang') };
        const tag = `cycle ${cycle} ${lang.toUpperCase()}`;
        if (JSON.stringify(withoutLang(s.storage)) !== JSON.stringify(withoutLang(base.storage))) problems.storage.push(tag);
        if (JSON.stringify(s.controls) !== JSON.stringify(base.controls)) problems.controls.push(tag);
        if (JSON.stringify(values(s.options)) !== JSON.stringify(values(base.options))) problems.options.push(tag);
        const dir = lang === 'ar' ? 'rtl' : 'ltr';
        if (s.lang.lang !== lang || s.lang.dir !== dir || s.lang.stored !== lang || s.lang.activeButton !== lang || s.lang.bodyDirection !== dir) problems.lang.push(tag + ' ' + JSON.stringify(s.lang));
        const dup = Object.entries(s.snap).filter(([k, v]) => duplicatedWord(v) && !baseDup.includes(k)).map(([k, v]) => k + ' = ' + JSON.stringify(v));
        if (dup.length) problems.dup.push(tag + ': ' + dup.join('; '));
        // Displayed person data: the username and every employee name, exactly as stored.
        const display = await h.ev(() => ({ bar: document.getElementById('authLoggedEmployee').textContent,
          wrong: ['task-employee', 'att-employee', 'po-requester'].flatMap((id) => Array.from(document.getElementById(id).options)
            .filter((o) => o.value && (o.textContent !== o.value || o.label !== o.value)).map((o) => `#${id} ${o.value} shown as ${o.textContent}`)) }));
        if (display.bar !== SESSION_NAME || display.wrong.length) problems.display.push(tag + ' ' + JSON.stringify(display));
        seen[lang] = s.snap;
      }
      if (!first) first = seen;
      else {
        for (const lang of ['ar', 'en']) {
          const d = diffSnap(first[lang], seen[lang]);
          if (d.length) problems.drift.push(`cycle ${cycle} ${lang.toUpperCase()} differs from cycle 1: ` + d.slice(0, 3).map((x) => `${x.key}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`).join('; '));
        }
      }
    }
    req('D2 10 cycles: stored business data and session byte-identical after every switch', () => assert.deepEqual(problems.storage, []));
    req('D2 10 cycles: every input / textarea / select .value unchanged after every switch', () => assert.deepEqual(problems.controls, []));
    req('D2 10 cycles: every option.value unchanged after every switch', () => assert.deepEqual(problems.options, []));
    req('D2 10 cycles: html lang/dir, computed direction, genops_language and active button agree after every switch', () => assert.deepEqual(problems.lang, []));
    req('D2 10 cycles: no duplicated words appear in UI text', () => assert.deepEqual(problems.dup, []));
    req(`D2 10 cycles: the username ("${SESSION_NAME}") and all ${VOCAB_EMPLOYEES.length} employee names display exactly as stored after every switch`, () =>
      assert.deepEqual(problems.display, []));
    req('D2 10 cycles: no progressive change — cycles 2-10 render exactly as cycle 1 in each language (no growing or drifting text)', () => assert.deepEqual(problems.drift, []));
    info(`D2 round-trip differences after cycle 1 (UI and user data, characterized in RT and U1): ${diffSnap(base.snap, first.en).length}`);
    cleanRun('D2', h);
    await h.context.close();
  });

  /* ---------- U1. displayed person / employee data (sections 10 and 19) ---------- */
  await scenario('U1', async () => {
    // Employee names that read like UI words, in both languages.
    // Including words that are explicitly translated UI copy elsewhere (phase 2).
    const NAMES = ['Now', 'NOW', 'Now Generator', 'Operating Hours', 'Fuel', 'Save', 'Employee & Time', 'IN', 'Selected photo 1',
      'الآن', 'ساعات التشغيل'];
    const SELECTED = { 'task-employee': 'Now', 'att-employee': 'ساعات التشغيل', 'po-requester': 'Fuel' };
    const h = await open(browser, { lang: 'en', session: user('Operating Hours'), employees: NAMES });
    for (const [id, value] of Object.entries(SELECTED)) await h.set(id, value);
    const read = () => h.ev((ids) => ({
      bar: document.getElementById('authLoggedEmployee').textContent,
      session: localStorage.getItem('genops_prototype_user'),
      selects: Object.fromEntries(ids.map((id) => {
        const select = document.getElementById(id);
        return [id, { value: select.value,
          options: Array.from(select.options).filter((o) => o.value).map((o) => [o.value, o.textContent, o.label]) }];
      }))
    }), Object.keys(SELECTED));
    const stages = [['EN load', await read()]];
    for (let cycle = 1; cycle <= 3; cycle++) {
      await h.switchTo('ar'); stages.push([`AR ${cycle}`, await read()]);
      await h.switchTo('en'); stages.push([`EN ${cycle}`, await read()]);
    }
    const stored = JSON.stringify(user('Operating Hours'));
    const shown = (s, name) => s.selects['task-employee'].options.find((o) => o[0] === name)[1];
    const trail = (name) => stages.map(([label, s]) => `${label} "${shown(s, name)}"`).join(', ');
    req('U1 session record unchanged by switching (username "Operating Hours")', () =>
      assert.deepEqual(stages.map(([, s]) => s.session), stages.map(() => stored)));
    req(`U1 every employee option (${NAMES.join(', ')}): value, text and label are exactly the name, in all three selects, at all ${stages.length} stages`, () => {
      const expected = NAMES.map((name) => [name, name, name]);
      for (const [label, s] of stages) {
        for (const id of Object.keys(SELECTED)) assert.deepEqual(s.selects[id].options, expected, `${label} #${id}`);
      }
    });
    req('U1 the selected employee of each select stays selected through every switch', () => {
      for (const [label, s] of stages) {
        for (const [id, value] of Object.entries(SELECTED)) assert.equal(s.selects[id].value, value, `${label} #${id}`);
      }
    });
    resolved('T-DISPLAY-01', stages.every(([, s]) => s.bar === 'Operating Hours'),
      'user bar: ' + stages.map(([label, s]) => `${label} "${s.bar}"`).join(', '));
    resolved('T-DISPLAY-02', stages.every(([, s]) => shown(s, 'Now') === 'Now'), 'option "Now": ' + trail('Now'));
    resolved('T-DISPLAY-03', stages.every(([, s]) => shown(s, 'Now Generator') === 'Now Generator'), 'option "Now Generator": ' + trail('Now Generator'));
    resolved('T-DISPLAY-04', ['الآن', 'ساعات التشغيل'].every((name) => stages.every(([, s]) => shown(s, name) === name)),
      'option "الآن": ' + trail('الآن') + '; option "ساعات التشغيل": ' + trail('ساعات التشغيل'));
    cleanRun('U1', h);
    await h.context.close();
  });

  /* ---------- E1. validation-error identity across a switch (section 11) ----------
     Required behavior (T-ERROR-01, resolved in phase 1):
     language switching may change wording,
     but MUST preserve the same validation-error identity. */
  await scenario('E1', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester') });
    await h.click('#nav-tasks');
    async function submitTask(end) {
      await h.set('task-name', 'Inspect'); await h.set('task-employee', 'Mukhtar Mohammed');
      await h.set('task-start-dt', '2026-09-25T10:00'); await h.set('task-end-dt', end); await h.set('task-desc', 'x');
      await h.ev(() => document.getElementById('formTasks').requestSubmit());
    }
    const read = () => h.ev(() => {
      const err = document.getElementById('err-task-end-dt');
      return { text: err.textContent, shown: err.classList.contains('show'),
        invalid: document.getElementById('task-end-dt').classList.contains('invalid'), reason: err.dataset.errorReason || null };
    });
    await submitTask('2026-09-25T09:00');
    const enShown = await read();
    await h.switchTo('ar'); const afterAr = await read();
    await h.switchTo('en'); const afterEn = await read();
    await h.switchTo('ar'); await submitTask('2026-09-25T09:00');
    const arShown = await read();
    await h.switchTo('en'); const arToEn = await read();
    // A corrected end time (the form still fails on an empty description): no stale reason.
    await h.set('task-end-dt', '2026-09-25T11:00'); await h.set('task-desc', '');
    await h.ev(() => document.getElementById('formTasks').requestSubmit());
    const corrected = await read();
    req('E1 EN submit with end before start shows "End time cannot be before start time"', () =>
      assert.deepEqual([enShown.text, enShown.shown, enShown.invalid], [END_BEFORE_START.en, true, true]));
    req('E1 AR submit with end before start shows the Arabic wording of the same reason', () =>
      assert.deepEqual([arShown.text, arShown.shown, arShown.invalid], [END_BEFORE_START.ar, true, true]));
    req('E1 the error stays shown and the field stays invalid through each switch', () =>
      assert.deepEqual([afterAr, afterEn, arToEn].map((s) => [s.shown, s.invalid]), [[true, true], [true, true], [true, true]]));
    req('E1 the semantic reason (end_before_start) is kept through every switch, with no revalidation', () =>
      assert.deepEqual([enShown, afterAr, afterEn, arShown, arToEn].map((s) => s.reason), Array(5).fill('end_before_start')));
    req('E1 once the end time is corrected the reason is cleared and the field shows its own message again', () =>
      assert.deepEqual([corrected.reason, corrected.shown, errorIdentity(corrected.text)], [null, false, 'end-required']));
    const wording = [[afterAr, 'ar'], [afterEn, 'en'], [arToEn, 'en']];
    resolved('T-ERROR-01', wording.every(([s, lang]) => errorIdentity(s.text) === 'end-before-start' && s.text === END_BEFORE_START[lang]),
      `after EN->AR "${afterAr.text}"; back to EN "${afterEn.text}"; raised in AR then AR->EN "${arToEn.text}"`);
    cleanRun('E1', h);
    await h.context.close();
  });

  /* ---------- E2. Generator form: the same reason mechanism (phase 1) ---------- */
  await scenario('E2', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester'),
      seed: { genops_generator_catalog_v1: [gen('id_g1', 'Gen', '100 kVA', 100)], genops_generator_runs_v1: [] } });
    await h.click('#nav-generators');
    await h.set('gen-name', 'id_g1');
    await h.until(() => document.getElementById('gen-start-hm').value === '100', null, 'opening reading');
    const read = () => h.ev(() => Object.fromEntries(['end-hm', 'end-dt'].map((f) => {
      const err = document.getElementById('err-gen-' + f);
      return [f, [err.classList.contains('show'), document.getElementById('gen-' + f).classList.contains('invalid'),
        err.dataset.errorReason || null, err.textContent]];
    })));
    // [label, start, end, end meter, expected reason per field (null: no error)]
    const CASES = [
      ['runtime 1 h elapsed, meter +10', '2026-09-25T08:00', '2026-09-25T09:00', '110', { 'end-hm': 'runtime_exceeds_elapsed', 'end-dt': null }],
      ['end before start, end meter below start', '2026-09-25T10:00', '2026-09-25T09:00', '99', { 'end-hm': 'end_reading_below_start', 'end-dt': 'end_before_start' }],
      ['end equal to start', '2026-09-25T08:00', '2026-09-25T08:00', '100.5', { 'end-hm': null, 'end-dt': 'end_not_after_start' }]];
    for (const [label, start, end, meter, reasons] of CASES) {
      await h.switchTo('en');
      await h.set('gen-start-dt', start); await h.set('gen-end-dt', end); await h.set('gen-end-hm', meter);
      await h.ev(() => document.getElementById('formGenerators').requestSubmit());
      const stages = [['EN', 'en', await read()]];
      await h.switchTo('ar'); stages.push(['EN->AR', 'ar', await read()]);
      await h.switchTo('en'); stages.push(['AR->EN', 'en', await read()]);
      req(`E2 Generator ${label}: each field keeps its reason through EN -> AR -> EN, worded in the current language`, () => {
        for (const [stage, lang, state] of stages) {
          for (const [field, reason] of Object.entries(reasons)) {
            const expected = reason ? [true, true, reason, GEN_REASONS[reason][lang]] : [false, false, null];
            assert.deepEqual(reason ? state[field] : state[field].slice(0, 3), expected, `${stage} #err-gen-${field}`);
          }
        }
      });
    }
    cleanRun('E2', h);
    await h.context.close();
  });

  /* ---------- M1. modern Generator / Fuel components render in the current language (section 12) ---------- */
  for (const lang of ['en', 'ar']) {
    await scenario('M1', async () => {
      const L = lang.toUpperCase();
      const seed = { genops_fuel_tanks_v1: [tank('id_t1', 'Source', 1000), tank('id_t2', 'Target', 1000)],
        genops_fuel_readings_v1: [reading('id_rd1', 'id_t1', '2026-09-24T06:00:00Z', 500, ''), reading('id_rd2', 'id_t2', '2026-09-24T06:00:00Z', 200, '')] };
      const h = await open(browser, { lang, session: user('tester'), seed });
      await h.click('#nav-generators');
      // open() has settled the page load; nothing is pending.
      const checks = [];
      const inLang = async (label, selector, exact) => {
        const state = await h.ev(([sel, l]) => ({ count: document.querySelectorAll(sel).length,
          explicit: Array.from(document.querySelectorAll(sel)).reduce((n, r) => n + window.__tr.explicitCount(r), 0),
          mismatches: window.__tr.explicitMismatchesIn(sel, l) }), [selector, lang]);
        const texts = await h.ev((pairs) => pairs.map(([s]) => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; }), exact);
        checks.push([label, state, texts, exact.map((e) => e[lang === 'ar' ? 2 : 1])]);
      };
      // Generator editor, created now.
      await h.click('#genmgrAddBtn');
      await h.until(() => !document.getElementById('genmgrEditor').hidden, null, 'generator editor');
      await inLang('Generator editor', '#genmgrEditor', [['#genmgrEditorTitle', 'Add Generator', 'إضافة مولدة'], ['#genmgrSaveLabel', 'Save', 'حفظ']]);
      for (const [id, v] of [['genmgr-name', 'Created Gen'], ['genmgr-size', '100 kVA'], ['genmgr-meter', '100'], ['genmgr-int-engine_oil', '250'],
        ['genmgr-int-oil_filter', '250'], ['genmgr-int-primary_fuel_filter', '250'], ['genmgr-int-air_filter', '250'], ['genmgr-fuel-rate', '5']]) await h.set(id, v);
      await h.ev(() => document.getElementById('genmgrEditor').requestSubmit());
      await h.until(() => document.querySelectorAll('#generatorOpsList .genmgr-ov').length === 1, null, 'generator card');
      await inLang('Generator card and service statuses', '#generatorOpsList .genmgr-ov',
        [['#generatorOpsList .genmgr-ring-label .genmgr-state', 'OK', 'جيد'], ['#generatorOpsList .genmgr-ov-edit', 'Edit', 'تعديل']]);
      await h.ev(() => { document.getElementById('gen-name').value = document.querySelector('#gen-name option[value]:not([value=""])').value;
        document.getElementById('gen-name').dispatchEvent(new Event('change', { bubbles: true })); });
      await h.until(() => document.querySelectorAll('#genmgrStatusList .genmgr-status-row').length === 4, null, 'service status rows');
      await inLang('Service status list', '#genmgrStatusCard', [['#genmgrStatusList .genmgr-state', 'OK', 'جيد']]);
      await h.click('#generatorOpsList [data-genmgr-delete]');
      await h.until(() => !!document.querySelector('#generatorOpsList .ops-confirm'), null, 'generator delete confirmation');
      await inLang('Generator delete confirmation', '#generatorOpsList .ops-confirm',
        [['#generatorOpsList .ops-confirm-title', 'Delete Generator?', 'حذف المولدة؟']]);
      // Fuel: tank editor, tank card, transfer editor, movement row, tank delete confirmation.
      await h.click('#secHeadFuel');
      await h.click('#fuelmgrAddTankBtn');
      await h.until(() => !document.getElementById('fuelmgrTankEditor').hidden, null, 'tank editor');
      await inLang('Fuel tank editor', '#fuelmgrTankEditor', [['#fuelmgrTankEditorTitle', 'Add Fuel Tank', 'إضافة خزان وقود']]);
      await h.set('fuelmgr-tank-name', 'Created Tank'); await h.set('fuelmgr-tank-capacity', '300');
      await h.ev(() => document.getElementById('fuelmgrTankEditor').requestSubmit());
      await h.until(() => document.querySelectorAll('#fuelTankList .fuelmgr-card').length === 3, null, 'tank card');
      await inLang('Fuel tank card (new tank)', '#fuelTankList .fuelmgr-card:last-child',
        [['#fuelTankList .fuelmgr-card:last-child .fuelmgr-basis', 'No readings yet', 'لا توجد قراءات بعد']]);
      await h.click('#fuelmgrTransferBtn');
      await h.until(() => !document.getElementById('fuelmgrTransferEditor').hidden, null, 'transfer editor');
      await inLang('Fuel transfer editor', '#fuelmgrTransferEditor', [['#fuelmgrTransferTitle', 'Transfer Fuel', 'مناقلة الوقود بين الخزانات']]);
      await h.set('fuelmgr-from', 'id_t1'); await h.set('fuelmgr-to', 'id_t2'); await h.set('fuelmgr-qty', '25');
      await h.ev(() => document.getElementById('fuelmgrTransferEditor').requestSubmit());
      await h.until(() => document.querySelectorAll('#fuelmgrMovementList .fuelmgr-move').length === 1, null, 'movement row');
      await inLang('Fuel movement display', '#fuelmgrMovementCard', [['#fuelmgrMovementList .fuelmgr-move-qty > span:last-child', 'L', 'لتر']]);
      await h.click('#fuelTankList .fuelmgr-card:last-child [data-fuelmgr-delete]');
      await h.until(() => !!document.querySelector('#fuelTankList .ops-confirm'), null, 'tank delete confirmation');
      await inLang('Fuel tank delete confirmation', '#fuelTankList .ops-confirm', [['#fuelTankList .ops-confirm-title', 'Delete Fuel Tank?', 'حذف خزان الوقود؟']]);
      for (const [label, state, texts, expected] of checks) {
        req(`M1 ${L} ${label}: rendered in ${L} at creation (${state.explicit} explicit strings, no later sweep)`, () => {
          assert.ok(state.count > 0 && state.explicit > 0, 'component not found');
          assert.deepEqual(state.mismatches, []);
          assert.deepEqual(texts, expected);
        });
      }
      // Nothing rewrites these components later: no delayed pass.
      const COMPONENTS = '#genmgrEditor, #generatorOpsList, #genmgrStatusCard, #fuelmgrTankEditor, #fuelTankList, #fuelmgrTransferEditor, #fuelmgrMovementCard';
      const markup = () => h.ev((roots) => Array.from(document.querySelectorAll(roots)).map((r) => r.innerHTML).join('\n'), COMPONENTS);
      const created = await markup();
      await h.settle();
      const later = await markup();
      req(`M1 ${L} nothing changes in the new components once they are created (${SETTLE_MS} ms later)`, () => assert.equal(later === created, true));
      cleanRun(`M1 ${L}`, h);
      await h.context.close();
    });
  }

  /* ---------- N1. Generator / Tank names stay raw (section 13) ---------- */
  await scenario('N1', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester'), seed: SEED_NAMES });
    const expected = {
      generatorCards: ['Now Generator', 'Fuel', 'Now Generator', 'Fuel'], generatorSizes: ['250 kVA', 'Operating Hours', '250 kVA', 'Operating Hours'],
      tankCards: ['Operating Hours', 'ساعات التشغيل', 'Operating Hours', 'ساعات التشغيل'],
      movementRoutes: [['Operating Hours', 'ساعات التشغيل']], movementNotes: ['Now'], movementIds: [['Fuel', 'no']],
      generatorOptions: ['Now Generator', 'Fuel'], tankOptions: ['Operating Hours', 'ساعات التشغيل']
    };
    const stages = { 'EN load': await h.tr('names') };
    await h.switchTo('ar'); stages['AR'] = await h.tr('names');
    await h.reload(); await h.settle(); stages['AR reload'] = await h.tr('names');
    await h.click('#nav-generators');
    await h.click('#generatorOpsList [data-genmgr-edit="id_g1"]');
    await h.until(() => !document.getElementById('genmgrEditor').hidden, null, 'generator editor');
    const editorValue = await h.ev(() => document.getElementById('genmgr-name').value);
    await h.click('#genmgrCancelBtn');
    stages['AR editor open/cancel'] = await h.tr('names');
    await h.switchTo('en'); stages['EN'] = await h.tr('names');
    // Mark the current cards; the re-render replaces every one of them.
    await h.ev(() => {
      document.querySelectorAll('.genmgr-ov, .fuelmgr-card').forEach((c) => { c.dataset.trOld = '1'; });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await h.until(() => document.querySelectorAll('.genmgr-ov, .fuelmgr-card').length === 8 &&
      !document.querySelector('[data-tr-old]'), null, 'cards re-rendered');
    stages['EN card re-render'] = await h.tr('names');
    for (const [stage, names] of Object.entries(stages)) {
      req(`N1 ${stage}: Generator / Tank names, sizes, movement route, notes and movement id ("Fuel", translate="no") shown exactly as stored`, () =>
        assert.deepEqual(names, expected));
    }
    req('N1 the editor opens with the exact stored name ("Now Generator")', () => assert.equal(editorValue, 'Now Generator'));
    cleanRun('N1', h);
    await h.context.close();
  });

  /* ---------- P1. placeholders (section 14) ---------- */
  await scenario('P1', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester') });
    const ids = ['authUsername', 'authPasscode', 'task-name', 'task-desc', 'po-desc', 'po-purpose', 'po-qty', 'po-cost',
      'fuel-second-reading', 'fuel-note', 'gen-start-hm', 'fuel-first-reading', 'gen-end-hm'];
    const selects = ['task-employee', 'att-employee', 'po-requester', 'att-type', 'gen-name', 'fuel-tank', 'fuelmgr-from', 'fuelmgr-to'];
    const read = () => h.ev(([i, s]) => ({
      ph: Object.fromEntries(i.map((id) => [id, document.getElementById(id).getAttribute('placeholder')])),
      sel: Object.fromEntries(s.map((id) => [id, document.querySelector('#' + id + ' option[value=""]').textContent]))
    }), [ids, selects]);
    const en0 = await read();
    await h.switchTo('ar'); const ar = await read();
    await h.switchTo('en'); const en1 = await read();
    // [EN, AR]: already bilingual and stable through a round trip.
    const STABLE = {
      authUsername: ['Enter username', 'أدخل اسم المستخدم'], authPasscode: ['Enter passcode', 'أدخل رمز الدخول'],
      'task-name': ['e.g. Replace fuel filter housing seal', 'مثال: تبديل سيل قاعدة فلتر الوقود'],
      'task-desc': ['Describe the work performed, parts used, observations…', 'اكتب العمل المنجز والمواد المستخدمة والملاحظات…'],
      'po-desc': ['What needs to be purchased?', 'ما المطلوب شراؤه؟'], 'po-purpose': ['Why is this needed?', 'لماذا هذا مطلوب؟'],
      'po-qty': ['e.g. 4', 'مثال: 4'], 'po-cost': ['0', '0'], 'fuel-second-reading': ['e.g. 4700', 'مثال: 4700'],
      'gen-start-hm': ['—', '—'], 'fuel-first-reading': ['—', '—']
    };
    for (const [id, [en, arText]] of Object.entries(STABLE)) {
      req(`P1 #${id} placeholder: EN "${en}", AR "${arText}", EN again "${en}"`, () => assert.deepEqual([en0.ph[id], ar.ph[id], en1.ph[id]], [en, arText, en]));
    }
    // Explicit since phase 2: exact both ways, ellipsis included (formerly T-RT-03).
    const TO_AR = { 'fuel-note': ['Add an optional note…', 'أضف ملاحظة اختيارية…'] };
    const SEL_TO_AR = { 'task-employee': ['Select employee…', 'اختر الموظف...'], 'att-employee': ['Select employee…', 'اختر الموظف...'],
      'po-requester': ['Select employee…', 'اختر الموظف...'], 'att-type': ['Select type…', 'اختر النوع...'], 'gen-name': ['Select generator…', 'اختر المولد...'],
      'fuel-tank': ['Select tank…', 'اختر الخزان…'], 'fuelmgr-from': ['Select tank…', 'اختر الخزان…'], 'fuelmgr-to': ['Select tank…', 'اختر الخزان…'] };
    for (const [id, [en, arText]] of Object.entries(TO_AR)) {
      req(`P1 #${id} placeholder: EN "${en}", AR "${arText}", EN again "${en}"`, () => assert.deepEqual([en0.ph[id], ar.ph[id], en1.ph[id]], [en, arText, en]));
    }
    for (const [id, [en, arText]] of Object.entries(SEL_TO_AR)) {
      req(`P1 #${id} placeholder option: EN "${en}", AR "${arText}", EN again "${en}"`, () =>
        assert.deepEqual([en0.sel[id], ar.sel[id], en1.sel[id]], [en, arText, en]));
    }
    resolved('T-PH-01', JSON.stringify([en0.ph['gen-end-hm'], ar.ph['gen-end-hm'], en1.ph['gen-end-hm']]) === JSON.stringify(['e.g. 1251.2', 'مثال: 1251.2', 'e.g. 1251.2']),
      `#gen-end-hm placeholder: EN "${en0.ph['gen-end-hm']}", AR "${ar.ph['gen-end-hm']}", EN again "${en1.ph['gen-end-hm']}"`);
    cleanRun('P1', h);
    await h.context.close();
  });

  /* ---------- O1. select option values and labels (section 15) ---------- */
  await scenario('O1', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester'), seed: SEED_NAMES });
    await h.set('att-type', 'BREAK IN');
    const selected = () => h.ev(() => document.getElementById('att-type').value);
    const en0 = await h.tr('options'); const selEn0 = await selected();
    await h.switchTo('ar'); const ar = await h.tr('options'); const selAr = await selected();
    await h.switchTo('en'); const en1 = await h.tr('options'); const selEn1 = await selected();
    const values = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map((x) => x.value)]));
    req('O1 option.value of every select identical in EN, AR and EN again', () => {
      assert.deepEqual(values(ar), values(en0));
      assert.deepEqual(values(en1), values(en0));
    });
    req('O1 Attendance type values stay IN, OUT, BREAK OUT, BREAK IN', () =>
      assert.deepEqual(ar['att-type'].map((o) => o.value), ['', 'IN', 'OUT', 'BREAK OUT', 'BREAK IN']));
    req('O1 Generator / Tank options: label is the exact name and carries no text node, in every language', () => {
      for (const s of [en0, ar, en1]) {
        assert.deepEqual(s['gen-name'].filter((o) => o.value).map((o) => [o.label, o.text]), [['Now Generator', ''], ['Fuel', '']]);
        assert.deepEqual(s['fuel-tank'].filter((o) => o.value).map((o) => [o.label, o.text]), [['Operating Hours', ''], ['ساعات التشغيل', '']]);
      }
    });
    req('O1 demo employee option text unchanged by switching (names that match no UI phrase)', () => {
      const names = (s) => s['task-employee'].filter((o) => o.value).map((o) => o.text);
      assert.deepEqual([names(ar), names(en1)], [names(en0), names(en0)]);
      assert.deepEqual(names(en0), ['Mukhtar Mohammed', 'Essam Hamza', 'Mohammed Jameel', 'Ali Yass']);
    });
    req('O1 the selected Attendance type (BREAK IN) stays selected through EN -> AR -> EN', () =>
      assert.deepEqual([selEn0, selAr, selEn1], ['BREAK IN', 'BREAK IN', 'BREAK IN']));
    req('O1 Attendance type option text stays the stable value text in every language', () => {
      for (const s of [en0, ar, en1]) assert.deepEqual(s['att-type'].filter((o) => o.value).map((o) => o.text), ['IN', 'OUT', 'BREAK OUT', 'BREAK IN']);
    });
    // The displayed text of an option is its label (HTML: the label attribute
    // when present, otherwise the text).
    const shown = (s) => s['att-type'].filter((o) => o.value).map((o) => o.label);
    resolved('T-OPT-01', JSON.stringify([shown(en0), shown(ar), shown(en1)]) === JSON.stringify([['IN', 'OUT', 'BREAK OUT', 'BREAK IN'],
      ['حضور', 'انصراف', 'خروج للاستراحة', 'عودة من الاستراحة'], ['IN', 'OUT', 'BREAK OUT', 'BREAK IN']]),
      `displayed labels: EN ${JSON.stringify(shown(en0))}, AR ${JSON.stringify(shown(ar))}, EN again ${JSON.stringify(shown(en1))}`);
    cleanRun('O1', h);
    await h.context.close();
  });

  /* ---------- V1. navigation (section 16) ---------- */
  await scenario('V1', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester') });
    const ids0 = (await navState(h)).ids;
    const states = [];
    for (let i = 0; i < 3; i++) {
      for (const lang of ['ar', 'en']) {
        await h.switchTo(lang);
        states.push([lang, await navState(h)]);
      }
    }
    req('V1 3 switches each way: drawer, tab bar, menu title, Overview title and ARIA labels exact every time', () => {
      for (const [lang, s] of states) {
        const e = expectedNav(lang);
        assert.deepEqual([s.drawer, s.quick, s.title, s.overview, s.aria], [e.drawer, e.quick, e.title, e.overview, e.aria]);
      }
    });
    req('V1 navigation identity (button ids, data-page) never depends on visible text', () => {
      for (const [, s] of states) assert.deepEqual(s.ids, ids0);
    });
    await h.switchTo('ar');
    const pages = await h.ev((nav) => nav.map(([id, page]) => {
      document.getElementById('drawer-' + id).click();
      const active = document.querySelector('.page.active');
      return [page, active && active.id, active && active.querySelector('h1').textContent.trim()];
    }), NAV);
    const h1 = { home: 'نظرة عامة', generators: 'المولدات', tasks: 'المهام', purchase: 'طلبات الشراء', projects: 'المشاريع',
      attendance: 'الحضور', reports: 'التقارير', users: 'المستخدمون', settings: 'الإعدادات' };
    req('V1 in Arabic every Side Menu entry opens its own page, whose title is in Arabic', () =>
      assert.deepEqual(pages, NAV.map(([, page]) => [page, 'page-' + page, h1[page]])));
    cleanRun('V1', h);
    await h.context.close();
  });

  /* ---------- A1. accessibility attributes (section 17) ---------- */
  await scenario('A1', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester') });
    const read = () => h.ev(() => {
      const t = document.getElementById('menuToggle');
      const closed = t.getAttribute('aria-label');
      t.click();
      const opened = [t.getAttribute('aria-label'), t.getAttribute('aria-expanded'), document.getElementById('mainDrawer').getAttribute('aria-hidden')];
      t.click();
      return { closed, opened, title: document.title, lang: document.documentElement.lang, dir: document.documentElement.dir,
        imgWithoutAlt: Array.from(document.querySelectorAll('img')).filter((i) => !i.hasAttribute('alt')).length };
    });
    const en0 = await read();
    await h.switchTo('ar'); const ar = await read();
    await h.switchTo('en'); const en1 = await read();
    req('A1 menu button aria-label (closed / open), aria-expanded and drawer aria-hidden follow the language', () => {
      assert.deepEqual([en0.closed, en0.opened], ['Open menu', ['Close menu', 'true', 'false']]);
      assert.deepEqual([ar.closed, ar.opened], ['فتح القائمة', ['إغلاق القائمة', 'true', 'false']]);
      assert.deepEqual([en1.closed, en1.opened], ['Open menu', ['Close menu', 'true', 'false']]);
    });
    req('A1 document lang/dir follow the language; document title stays the brand "tîşk"', () => {
      assert.deepEqual([en0.lang, en0.dir, ar.lang, ar.dir, en1.lang, en1.dir], ['en', 'ltr', 'ar', 'rtl', 'en', 'ltr']);
      assert.deepEqual([en0.title, ar.title, en1.title], ['tîşk', 'tîşk', 'tîşk']);
    });
    cleanRun('A1', h);
    await h.context.close();
  });

  /* ---------- I1. image preview (section 18) ---------- */
  await scenario('I1', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester') });
    await h.click('#nav-tasks');
    // A real JPEG, generated in memory by the browser; nothing is written to disk.
    const jpeg = Buffer.from(await h.ev(() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 48;
      const x = c.getContext('2d'); x.fillStyle = '#21E6E6'; x.fillRect(0, 0, 64, 48);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    }), 'base64');
    const fixture = (n) => ({ name: `fixture-${n}.jpg`, mimeType: 'image/jpeg', buffer: jpeg });
    const previews = () => h.ev(() => Array.from(document.querySelectorAll('#task-preview-grid .preview-thumb img'))
      .map((img) => [img.getAttribute('alt'), img.getAttribute('src').slice(0, 23)]));
    await h.page.setInputFiles('#task-photo-gallery', fixture(1));
    await h.until(() => document.querySelectorAll('#task-preview-grid img').length === 1, null, 'first preview');
    const en = await previews();
    await h.switchTo('ar'); const arAfterSwitch = await previews();
    await h.page.setInputFiles('#task-photo-gallery', fixture(2));
    await h.until(() => document.querySelectorAll('#task-preview-grid img').length === 2, null, 'second preview');
    const arAdded = await previews();
    await h.switchTo('en'); const enBack = await previews();
    await h.switchTo('ar');
    // Removing the first photo renumbers the remaining one.
    await h.click('#task-preview-grid .rm[data-idx="0"]');
    const afterRemove = await previews();
    await h.set('task-name', 'Photo task'); await h.set('task-employee', 'Ali Yass'); await h.set('task-end-dt', '2026-09-25T12:30');
    await h.set('task-start-dt', '2026-09-25T12:00'); await h.set('task-desc', 'x');
    await h.ev(() => document.getElementById('formTasks').requestSubmit());
    const afterSubmit = await h.ev(() => ({ previews: document.querySelectorAll('#task-preview-grid .preview-thumb').length,
      toast: Array.from(document.querySelectorAll('#toastStack .t-title')).map((t) => t.textContent) }));
    req('I1 a selected JPEG shows one compressed JPEG preview (data URL, no upload)', () => assert.deepEqual(en, [['Selected photo 1', 'data:image/jpeg;base64,']]));
    req('I1 a second photo adds a second preview; removing one leaves one', () => {
      assert.equal(arAdded.length, 2);
      assert.equal(afterRemove.length, 1);
    });
    req('I1 a recorded prototype submission clears the attachments and confirms in Arabic', () =>
      assert.deepEqual(afterSubmit, { previews: 0, toast: ['تم تسجيل العملية في النسخة التجريبية.'] }));
    const alts = (list) => list.map((p) => p[0]);
    resolved('T-ALT-01', JSON.stringify([alts(arAfterSwitch), alts(arAdded), alts(enBack), alts(afterRemove)]) === JSON.stringify([
      ['الصورة المختارة 1'], ['الصورة المختارة 1', 'الصورة المختارة 2'], ['Selected photo 1', 'Selected photo 2'], ['الصورة المختارة 1']]),
      `preview alt: after EN->AR ${JSON.stringify(alts(arAfterSwitch))}, added in Arabic ${JSON.stringify(alts(arAdded))}, ` +
      `back in English ${JSON.stringify(alts(enBack))}, Arabic after removing the first ${JSON.stringify(alts(afterRemove))}`);
    cleanRun('I1', h);
    await h.context.close();
  });

  /* ---------- B1. buttons (section 19) ---------- */
  await scenario('B1', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester') });
    // [selector, EN, AR]; read as visible text (whitespace collapsed).
    const BUTTONS = [
      ['#task-cam-btn', 'Camera', 'الكاميرا'], ['#task-gal-btn', 'Gallery', 'المعرض'], ['#att-cam-btn', 'Camera', 'الكاميرا'],
      ['#att-gal-btn', 'Gallery', 'المعرض'], ['#po-cam-btn', 'Camera', 'الكاميرا'], ['#po-gal-btn', 'Gallery', 'المعرض'],
      ['#btnSubmitGen .btn-label', 'Submit Generator Record', 'اعتماد سجل المولد'], ['#btnSubmitTask .btn-label', 'Submit Task', 'اعتماد المهمة'],
      ['#btnSubmitAtt .btn-label', 'Submit Attendance', 'اعتماد الحضور'], ['#btnSubmitPO .btn-label', 'Submit Purchase Request', 'إرسال طلب الشراء'],
      ['#btnSubmitFuel .btn-label', 'Submit Fuel Consumption', 'اعتماد استهلاك الوقود'],
      ['#genmgrAddBtn', 'Add Generator', 'إضافة مولدة'], ['#fuelmgrAddTankBtn', 'Add Fuel Tank', 'إضافة خزان وقود'],
      ['#fuelmgrTransferBtn', 'Transfer Fuel', 'مناقلة الوقود بين الخزانات'], ['#genmgrSaveLabel', 'Save', 'حفظ'],
      ['#genmgrCancelBtn', 'Cancel', 'إلغاء'], ['#fuelmgrTankSaveBtn .btn-label', 'Save', 'حفظ'], ['#fuelmgrTankCancelBtn', 'Cancel', 'إلغاء'],
      ['#authLoginButton', 'Sign In', 'تسجيل الدخول'], ['#authLogoutButton', 'Logout', 'تسجيل الخروج']];
    const read = () => h.ev((list) => ({
      buttons: list.map(([s]) => document.querySelector(s).textContent.replace(/\s+/g, ' ').trim()),
      now: Array.from(document.querySelectorAll('.btn-now[data-target]')).map((b) => b.textContent.replace(/\s+/g, ' ').trim())
    }), BUTTONS);
    const en0 = await read();
    await h.switchTo('ar'); const ar = await read();
    await h.switchTo('en'); const en1 = await read();
    BUTTONS.forEach(([selector, en, arText], i) => {
      req(`B1 ${selector}: "${en}" / "${arText}" / "${en}" (no case change, no mixed text)`, () =>
        assert.deepEqual([en0.buttons[i], ar.buttons[i], en1.buttons[i]], [en, arText, en]));
    });
    req(`B1 the ${en0.now.length} NOW buttons read "NOW" in English, "الآن" in Arabic and "NOW" again`, () => {
      assert.ok(en0.now.length >= 7);
      assert.deepEqual([new Set(en0.now), new Set(ar.now), new Set(en1.now)], [new Set(['NOW']), new Set(['الآن']), new Set(['NOW'])]);
    });
    // The Purchase button is explicitly owned: it is right at the moment of
    // the switch, and nothing changes it afterwards.
    const purchase = [];
    const button = () => h.ev(() => { const b = document.getElementById('btnSubmitPO'); return [b.innerHTML, b.textContent.replace(/\s+/g, ' ').trim()]; });
    for (const lang of ['ar', 'en']) {
      await h.switchTo(lang, false);
      const atSwitch = await button();
      await h.settle();
      purchase.push([atSwitch[1], (await button())[0] === atSwitch[0]]);
    }
    req('B1 the Purchase button is complete at the moment of the switch and unchanged afterwards, in both languages', () =>
      assert.deepEqual(purchase, [['إرسال طلب الشراء', true], ['Submit Purchase Request', true]]));
    cleanRun('B1', h);
    await h.context.close();
  });

  /* ---------- RT. round-trip text stability (section 20) ---------- */
  await scenario('RT', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester') });
    const before = await h.tr('snap');
    await h.switchTo('ar');
    await h.switchTo('en');
    const after = await h.tr('snap');
    const diffs = diffSnap(before, after);
    const whitespaceOnly = diffs.filter((d) => norm(d.before) === norm(d.after));
    const real = diffs.filter((d) => norm(d.before) !== norm(d.after));
    const byDebt = Object.fromEntries(RT_DEBT.map(([id]) => [id, []]));
    const unregistered = [];
    for (const d of real) {
      const hit = RT_DEBT.find(([, match]) => match(d));
      (hit ? byDebt[hit[0]] : unregistered).push(`${d.key}: ${JSON.stringify(norm(d.before))} -> ${JSON.stringify(norm(d.after))}`);
    }
    info(`RT ${Object.keys(before).length} UI strings captured; ${real.length} changed by EN -> AR -> EN; ${whitespaceOnly.length} whitespace-only`);
    whitespaceOnly.forEach((d) => info(`RT whitespace-only: ${d.key}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`));
    req(`RT EN -> AR -> EN returns every one of the ${Object.keys(before).length} UI strings and attributes to its exact source text`, () =>
      assert.deepEqual(diffs.map((d) => `${d.key}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`), []));
    req('RT no round-trip change outside the formerly registered classes', () => assert.deepEqual(unregistered, []));
    for (const [id] of RT_DEBT) resolved(id, byDebt[id].length === 0, byDebt[id].length ? byDebt[id].join('\n      ') : 'no such change');
    cleanRun('RT', h);
    await h.context.close();
  });

  /* ---------- TM. timing: at the switch vs SETTLE_MS later (section 21) ---------- */
  await scenario('TM', async () => {
    const h = await open(browser, { lang: 'en', session: user('tester') });
    const explicit = {};
    const arImmediate = await h.switchTo('ar', false);
    explicit.ar = await h.tr('explicitMismatches', 'ar');
    const navAr = await navState(h);
    await h.settle();
    const arSettled = await h.tr('snap');
    const enImmediate = await h.switchTo('en', false);
    explicit.en = await h.tr('explicitMismatches', 'en');
    const navEn = await navState(h);
    await h.settle();
    const enSettled = await h.tr('snap');
    req('TM explicitly owned UI copy (text, own text, placeholder / alt / label attributes) is complete at the moment of the switch, both ways', () =>
      assert.deepEqual(explicit, { ar: [], en: [] }));
    req('TM navigation labels and ARIA labels are complete at the moment of the switch, both ways', () => {
      const e = [expectedNav('ar'), expectedNav('en')];
      assert.deepEqual([navAr.drawer, navAr.quick, navAr.aria], [e[0].drawer, e[0].quick, e[0].aria]);
      assert.deepEqual([navEn.drawer, navEn.quick, navEn.aria], [e[1].drawer, e[1].quick, e[1].aria]);
    });
    const late = { ar: diffSnap(arImmediate, arSettled), en: diffSnap(enImmediate, enSettled) };
    // Page load: anything that still changes after an Arabic, then an English, reload.
    await h.switchTo('ar');
    await h.reload();
    const atLoad = await h.tr('snap');
    await h.settle();
    const loadLate = diffSnap(atLoad, await h.tr('snap'));
    await h.switchTo('en');
    await h.reload();
    const atEnLoad = await h.tr('snap');
    await h.settle();
    const enLoadLate = diffSnap(atEnLoad, await h.tr('snap'));
    const sample = (list) => list.slice(0, 4).map((d) => `${d.key}: ${JSON.stringify(norm(d.before))} -> ${JSON.stringify(norm(d.after))}`).join('; ');
    resolved('T-TIME-01', late.ar.length + late.en.length + loadLate.length + enLoadLate.length === 0,
      `changed later: after EN->AR ${late.ar.length} (${sample(late.ar)}); after AR->EN ${late.en.length} (${sample(late.en)}); ` +
      `after an Arabic page load ${loadLate.length} (${sample(loadLate)}); after an English page load ${enLoadLate.length} (${sample(enLoadLate)})`);
    cleanRun('TM', h);
    await h.context.close();
  });

  /* ---------- X1. explicit ownership at creation (phase 2) ----------
     The converted screens (Generator Run, Fuel Reading, Tasks, Management,
     Supply), created in a language: correct at once, when the page has
     loaded; nothing changes afterwards; no UI copy there is without explicit
     ownership or a raw-data marker. */
  const SCREENS = '#page-generators, #page-tasks, #page-attendance, #page-purchase';
  const NEUTRAL = ['IQD']; // a currency code, the same in both languages
  for (const lang of ['en', 'ar']) {
    await scenario('X1', async () => {
      const L = lang.toUpperCase();
      const h = await open(browser, { lang, session: user('tester'), seed: SEED_NAMES, settle: false });
      // The page has loaded; no timer has run yet.
      const atLoad = { mismatches: await h.tr('explicitMismatches', lang), total: await h.tr('explicitTotal'), snap: await h.tr('snap'),
        employee: await h.ev(() => Array.from(document.querySelectorAll('#task-employee, #att-employee, #po-requester'))
          .map((select) => { const option = select.querySelector('option[value=""]'); return [option.textContent, option.hasAttribute('data-auth-en')]; })) };
      await h.settle();
      const settled = await h.tr('snap');
      const unowned = (await h.tr('unowned', SCREENS)).filter((line) => !NEUTRAL.some((word) => line.endsWith(' = ' + JSON.stringify(word))));
      req(`X1 ${L} load: all ${atLoad.total} explicitly owned UI strings are in ${L} at once, when the page has loaded`, () =>
        assert.deepEqual(atLoad.mismatches, []));
      req(`X1 ${L} load: the three employee placeholders are created in ${L} and explicitly owned`, () =>
        assert.deepEqual(atLoad.employee, Array(3).fill([lang === 'ar' ? 'اختر الموظف...' : 'Select employee…', true])));
      req(`X1 ${L} load: nothing changes after the page load (${SETTLE_MS} ms later)`, () =>
        assert.deepEqual(diffSnap(atLoad.snap, settled).map((d) => `${d.key}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`), []));
      req(`X1 ${L}: no UI copy in Generator Run, Fuel Reading, Tasks, Management or Supply is without explicit ownership or a raw-data marker`, () =>
        assert.deepEqual(unowned, []));
      cleanRun(`X1 ${L}`, h);
      await h.context.close();
    });
  }

  /* ---------- S1. login / session timing (section 22) ---------- */
  await scenario('S1', async () => {
    const NAME = 'Operating Hours';
    const variants = {};
    // The whole user bar: name, role, logout label.
    const read = async (h) => ({ h, session: await h.ev(() => localStorage.getItem('genops_prototype_user')),
      bar: await h.ev(() => [document.getElementById('authLoggedEmployee').textContent, document.getElementById('authLoggedRole').textContent,
        document.getElementById('authLogoutButton').textContent.trim()]) });
    // a. Arabic already selected; login right after the page load, before any timer.
    let h = await open(browser, { lang: 'ar', settle: false });
    await h.login(NAME); await h.settle();
    variants.loginAtLoad = await read(h);
    // b. Arabic restored on page load with an existing session.
    h = await open(browser, { lang: 'ar', session: user(NAME) });
    variants.restored = await read(h);
    // c. Arabic selected; login once the page has settled.
    h = await open(browser, { lang: 'ar' });
    await h.login(NAME); await h.settle();
    variants.loginAfterSettle = await read(h);
    const stored = JSON.stringify(user(NAME));
    req('S1 the stored session is identical in all three cases ({"username":"Operating Hours",...})', () =>
      assert.deepEqual(Object.values(variants).map((v) => v.session), [stored, stored, stored]));
    req('S1 login at page load, restored session and login once the page has settled all show the exact raw username', () =>
      assert.deepEqual(Object.values(variants).map((v) => v.bar[0]), [NAME, NAME, NAME]));
    const bars = Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.bar]));
    resolved('T-SESSION-01', Object.values(bars).every((b) => JSON.stringify(b) === JSON.stringify([NAME, 'مدير', 'تسجيل الخروج'])),
      `user bar under Arabic: login at page load ${JSON.stringify(bars.loginAtLoad)}, restored session ${JSON.stringify(bars.restored)}, login once settled ${JSON.stringify(bars.loginAfterSettle)}`);
    for (const [k, v] of Object.entries(variants)) { cleanRun(`S1 ${k}`, v.h); await v.h.context.close(); }
  });

  /* ---------- ARCH. the legacy translation architecture stays removed (phase 3) ----------
     Source: none of the seven text-replacement translators, their
     initializers, refresh closures, helper or table entries; no text-node
     sweep; no deferred callback runs translation code. Runtime: none of them
     exists, and a full language switch in a busy state schedules nothing and
     is complete in the same task, both ways. */
  await scenario('ARCH', async () => {
    const source = fs.readFileSync(HTML, 'utf8');
    const present = (list) => list.filter((s) => source.includes(s));
    req(`ARCH production source contains none of the seven legacy translators (${LEGACY_TRANSLATORS.join(', ')})`, () =>
      assert.deepEqual(present(LEGACY_TRANSLATORS), []));
    req('ARCH production source contains none of their initializers, delayed refresh closures, legacyTranslatable or table entries', () =>
      assert.deepEqual(present(LEGACY_HELPERS.concat(LEGACY_TABLE_ENTRIES)), []));
    req('ARCH production source has no text-node sweep (createTreeWalker / SHOW_TEXT), the mechanism of every legacy pass', () =>
      assert.deepEqual(present(['createTreeWalker', 'SHOW_TEXT']), []));
    const deferred = deferredCallbacks(source);
    deferred.forEach((d) => info(`ARCH deferred callback ${d.api} at line ${d.line} (${d.translates ? 'TRANSLATES' : 'no translation'}): ${norm(d.args).slice(0, 100)}`));
    req(`ARCH none of the ${deferred.length} deferred callbacks in production (timers, frame / idle callbacks, observers) schedules translation`, () =>
      assert.deepEqual(deferred.filter((d) => d.translates).map((d) => `${d.api} at line ${d.line}: ${norm(d.args).slice(0, 120)}`), []));

    const h = await open(browser, { lang: 'en', session: user('tester'), seed: SEED_NAMES });
    const defined = await h.ev((names) => names.filter((n) => typeof window[n] !== 'undefined'), LEGACY_TRANSLATORS.concat(LEGACY_HELPERS));
    req('ARCH none of the legacy translators, initializers or helpers is defined in the running page', () => assert.deepEqual(defined, []));
    // A busy state: a photo preview, a cross-field Generator error, required-field
    // errors in the other forms, the Generator editor, a delete confirmation,
    // a selected tank and the Fuel transfer editor.
    await h.click('#nav-tasks');
    const jpeg = Buffer.from(await h.ev(() => {
      const c = document.createElement('canvas'); c.width = 32; c.height = 24;
      const x = c.getContext('2d'); x.fillStyle = '#21E6E6'; x.fillRect(0, 0, 32, 24);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    }), 'base64');
    await h.page.setInputFiles('#task-photo-gallery', { name: 'fixture.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    await h.until(() => document.querySelectorAll('#task-preview-grid img').length === 1, null, 'photo preview');
    await h.click('#nav-generators');
    await h.set('gen-name', 'id_g1');
    await h.until(() => document.getElementById('gen-start-hm').value === '100', null, 'opening reading');
    await h.set('gen-start-dt', '2026-09-25T10:00'); await h.set('gen-end-dt', '2026-09-25T09:00'); await h.set('gen-end-hm', '99');
    await h.ev(() => ['formGenerators', 'formTasks', 'formAttendance', 'formPurchase'].forEach((id) => document.getElementById(id).requestSubmit()));
    await h.click('#genmgrAddBtn');
    await h.until(() => !document.getElementById('genmgrEditor').hidden, null, 'generator editor');
    await h.click('#generatorOpsList [data-genmgr-delete]');
    await h.until(() => !!document.querySelector('#generatorOpsList .ops-confirm'), null, 'generator delete confirmation');
    await h.click('#secHeadFuel');
    await h.set('fuel-tank', 'id_t1');
    await h.click('#fuelmgrTransferBtn');
    await h.until(() => !document.getElementById('fuelmgrTransferEditor').hidden, null, 'transfer editor');
    await h.settle();
    const busy = await h.ev(() => ({ previews: document.querySelectorAll('#task-preview-grid img').length,
      errors: document.querySelectorAll('.show[id^="err-"]').length, reason: document.getElementById('err-gen-end-dt').dataset.errorReason || null,
      editors: ['genmgrEditor', 'fuelmgrTransferEditor'].filter((id) => !document.getElementById(id).hidden).length,
      confirm: document.querySelectorAll('.ops-confirm').length, strings: Object.keys(window.__tr.snap()).length }));
    info(`ARCH busy state: ${busy.strings} UI strings, ${busy.errors} field errors, ${busy.previews} preview, ${busy.editors} editors, ${busy.confirm} confirmation`);
    req('ARCH the busy state is reached (preview, cross-field and required-field errors, two editors, a delete confirmation)', () =>
      assert.deepEqual([busy.previews, busy.errors > 3, busy.reason, busy.editors, busy.confirm], [1, true, 'end_before_start', 2, 1]));
    // Clicks the language button with every scheduling API recorded, then
    // reads the page in the same task.
    const switchRecorded = (lang) => h.ev((l) => {
      const scheduled = [];
      const describe = (fn) => String(fn).replace(/\s+/g, ' ').slice(0, 80);
      const apis = ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'].filter((n) => typeof window[n] === 'function');
      const saved = {};
      apis.forEach((n) => { saved[n] = window[n]; window[n] = function (...args) { scheduled.push(`${n}(${describe(args[0])}, ${args[1]})`); return saved[n].apply(this, args); }; });
      const Observer = window.MutationObserver;
      window.MutationObserver = function (callback) { scheduled.push(`MutationObserver(${describe(callback)})`); return new Observer(callback); };
      try { document.getElementById(l === 'ar' ? 'btnLangAr' : 'btnLangEn').click(); } finally {
        apis.forEach((n) => { window[n] = saved[n]; });
        window.MutationObserver = Observer;
      }
      return { scheduled, mismatches: window.__tr.explicitMismatches(l), total: window.__tr.explicitTotal(), snap: window.__tr.snap(), lang: window.__tr.lang() };
    }, lang);
    const switches = {};
    for (const lang of ['ar', 'en']) {
      const atSwitch = await switchRecorded(lang);
      await h.settle();
      switches[lang] = Object.assign(atSwitch, { later: diffSnap(atSwitch.snap, await h.tr('snap')) });
    }
    const both = (fn) => ({ ar: fn(switches.ar), en: fn(switches.en) });
    req('ARCH a full language switch in a busy state schedules no timer, frame / idle callback or observer, both ways', () =>
      assert.deepEqual(both((s) => s.scheduled), { ar: [], en: [] }));
    req(`ARCH all ${switches.ar.total} explicitly owned UI strings of the busy state are in the new language in the same task, both ways`, () =>
      assert.deepEqual(both((s) => s.mismatches), { ar: [], en: [] }));
    req('ARCH the language attributes and the active button are set in the same task, both ways', () =>
      assert.deepEqual(both((s) => s.lang), { ar: { lang: 'ar', dir: 'rtl', stored: 'ar', bodyDirection: 'rtl', activeButton: 'ar' },
        en: { lang: 'en', dir: 'ltr', stored: 'en', bodyDirection: 'ltr', activeButton: 'en' } }));
    req(`ARCH nothing in the busy state changes after the switch (${SETTLE_MS} ms later): the switch is complete immediately, both ways`, () =>
      assert.deepEqual(both((s) => s.later.map((d) => `${d.key}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`)), { ar: [], en: [] }));
    cleanRun('ARCH', h);
    await h.context.close();
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  try { await run(browser); } finally { await browser.close(); server.close(); }
  if (!process.env.ONLY) {
    Object.keys(RESOLVED_DEBT).filter((id) => !evaluatedResolved.has(id))
      .forEach((id) => R.unexpected.push(`RESOLVED_DEBT ${id} was never evaluated`));
  }
  const out = path.join(process.env.RESULTS_DIR ? path.resolve(process.env.RESULTS_DIR) : os.tmpdir(), 'translation-safety-results.json');
  fs.writeFileSync(out, JSON.stringify(R, null, 2));
  console.log('results: ' + out);
  console.log(`REQUIRED PASS: ${R.requiredPass.length}`);
  console.log(`REQUIRED FAIL: ${R.requiredFail.length}`);
  console.log(`UNEXPECTED CHANGE: ${R.unexpected.length}`);
  console.log(`RESOLVED_DEBT (REQUIRED): ${Object.keys(RESOLVED_DEBT).join(', ')}`);
  R.requiredFail.forEach((f) => console.log('REQUIRED FAIL ' + f));
  R.unexpected.forEach((u) => console.log('UNEXPECTED CHANGE ' + u));
  R.info.forEach((line) => console.log('INFO ' + line));
  process.exitCode = R.requiredFail.length || R.unexpected.length ? 1 : 0;
})();
