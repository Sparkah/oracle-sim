// Headless browser QA. Boots the page, waits for the mechs to load, picks two bots, runs a
// bout, and screenshots at fixed points so the frames can be read back with vision.
//
//   node qa/qa.cjs            # needs the preview server on 8099
//
// captureBeyondViewport:false is not optional - the default hangs forever on a canvas that
// is animating every frame.

const path = require('path');
const puppeteer = require(path.join(process.env.HOME, 'Agents/Games/10_running_away/node_modules/puppeteer'));

const URL = process.env.QA_URL || 'http://127.0.0.1:8099/Shared/experiments/battlebots-sim-3d/';
const OUT = path.join(__dirname, 'shots');
const TAG = process.env.QA_TAG || 'default';
const PICK_A = process.env.QA_A || '';   // bot ids, e.g. QA_A=manta QA_B=skorpios
const PICK_B = process.env.QA_B || '';
require('fs').mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const errors = [];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
  // a bare "Failed to load resource" console line does not say WHICH resource, and a missing
  // .glb and a missing favicon are not the same problem
  page.on('response', (r) => { if (r.status() >= 400) errors.push('http ' + r.status() + ': ' + r.url()); });

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, TAG + '-' + name + '.png'), captureBeyondViewport: false });
    process.stderr.write('shot ' + TAG + '-' + name + '\n');
  };

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // wait for RUN FIGHT to arm - that only happens after data + all four GLBs are in
  await page.waitForFunction(
    () => { const b = document.getElementById('runBtn'); return b && !b.disabled; },
    { timeout: 90000, polling: 400 },
  );
  await sleep(1200);
  await shot('01-idle-arena');

  // every weapon rig builds, including the two the current scrape has no bots for
  const rigs = await page.evaluate(async () => {
    const m = await import('./js/arena3d.js');
    const out = {};
    for (const k of ['vspinner', 'hspinner', 'flipper', 'crusher', 'hammer', 'control']) {
      try {
        const w = m.buildWeapon(k, 0xe8503a);
        w.strike(); w.update(0.1, true);
        let meshes = 0; w.group.traverse((o) => { if (o.isMesh) meshes++; });
        out[k] = 'ok:' + meshes + ' meshes';
      } catch (e) { out[k] = 'THREW: ' + e.message; }
    }
    return out;
  });

  const picked = await page.evaluate(({ a: wa, b: wb }) => {
    const a = document.getElementById('selA'), b = document.getElementById('selB');
    if (wa) { a.value = wa; a.dispatchEvent(new Event('change')); }
    if (wb) { b.value = wb; b.dispatchEvent(new Event('change')); }
    return { a: a.options[a.selectedIndex].text, b: b.options[b.selectedIndex].text };
  }, { a: PICK_A, b: PICK_B });
  process.stderr.write('matchup: ' + picked.a + ' vs ' + picked.b + '\n');

  await page.click('#runBtn');
  await sleep(3500); await shot('02-fight-early');
  await sleep(4500); await shot('03-fight-mid');
  await sleep(5000); await shot('04-fight-late');

  // wait for the winner card, then grab it
  try {
    await page.waitForFunction(() => !document.getElementById('card').hidden, { timeout: 45000, polling: 400 });
  } catch { errors.push('winner card never appeared'); }
  await sleep(900);
  await shot('05-winner-card');

  const state = await page.evaluate(() => ({
    hpA: document.getElementById('hpValA').textContent,
    hpB: document.getElementById('hpValB').textContent,
    clock: document.getElementById('clock').textContent,
    winner: document.getElementById('cardWin').textContent,
    method: document.getElementById('cardMethod').textContent,
    call: document.getElementById('cardCall').textContent,
    feed: [...document.querySelectorAll('#feed li')].map((l) => l.textContent),
    badge: document.getElementById('srcBadge').textContent,
    canvas: (() => { const c = document.getElementById('gl'); return c.width + 'x' + c.height; })(),
  }));

  // second bout from the card, to prove teardown/rebuild works
  await page.click('#againBtn');
  await sleep(6000); await shot('06-second-bout');

  process.stdout.write(JSON.stringify({ tag: TAG, picked, rigs, state, errors }, null, 2) + '\n');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { process.stdout.write('FATAL ' + e.message + '\n'); process.exit(2); });
