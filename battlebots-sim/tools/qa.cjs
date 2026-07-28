// Headless QA: boots the page, plays a real fight, screenshots every view.
//   node tools/qa.cjs
const puppeteer = require('/Users/timmarkin/Agents/Games/10_running_away/node_modules/puppeteer');
const path = require('path');
const fs = require('fs');

const URL = 'http://127.0.0.1:8099/Shared/experiments/battlebots-sim/';
const OUT = path.join(__dirname, '..', 'qa');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// captureBeyondViewport makes Chrome re-composite the whole page off-screen, which stalls
// indefinitely while the arena canvas is driving a rAF loop under machine contention.
// Pinning it off is the difference between this finishing and hanging at 01-boot.
const shot = (page, name, extra = {}) =>
  page.screenshot({ path: path.join(OUT, name), captureBeyondViewport: false, ...extra });

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    // generous: parallel agent sessions on this machine run their own Chrome instances and
    // the default 30s launch window loses the race under that contention
    timeout: 90000,
    protocolTimeout: 180000,
    args: ['--no-sandbox', '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });

  const errors = [], logs = [];
  page.on('console', (m) => { logs.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url() + ' ' + (r.failure() || {}).errorText));

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 20000 });
  await sleep(900);

  const fail = [];
  const check = (cond, msg) => { if (!cond) fail.push(msg); };

  // --- boot state
  const boot = await page.evaluate(() => ({
    prov: document.getElementById('provenance').textContent.trim(),
    provClass: document.getElementById('provenance').className,
    optsA: document.getElementById('selA').options.length,
    optsB: document.getElementById('selB').options.length,
    statA: document.getElementById('statA').textContent.trim(),
    pbA: document.getElementById('pbA').textContent,
    pbB: document.getElementById('pbB').textContent,
    pbW: document.getElementById('pbFill').style.width,
    canvasW: document.getElementById('arena').width,
    canvasH: document.getElementById('arena').height,
    predcap: document.getElementById('predcap').textContent.trim(),
  }));
  check(boot.optsA === 24 && boot.optsB === 24, `expected 24 options, got ${boot.optsA}/${boot.optsB}`);
  check(boot.prov.length > 0, 'provenance badge empty');
  check(boot.statA.length > 0, 'stat line A empty');
  check(boot.canvasW > 0 && boot.canvasH > 0, `canvas has zero size ${boot.canvasW}x${boot.canvasH}`);
  check(/\d+%/.test(boot.pbA), 'prediction bar A has no percentage');
  const sum = parseInt(boot.pbA) + parseInt(boot.pbB);
  check(Math.abs(sum - 100) <= 1, `prediction halves sum to ${sum}, not 100`);
  check(boot.predcap.length > 10, 'prediction caption missing');

  await shot(page, '01-boot.png');

  // --- run a fight
  await page.click('#fight');
  await sleep(4200);
  const mid = await page.evaluate(() => ({
    feed: document.getElementById('feed').children.length,
    hpA: document.getElementById('hpValA').textContent,
    hpB: document.getElementById('hpValB').textContent,
    clock: document.getElementById('clock').textContent,
    disabled: document.getElementById('fight').disabled,
  }));
  check(mid.feed > 1, `commentary feed did not populate (${mid.feed} items)`);
  check(mid.disabled === true, 'fight button not disabled during a bout');
  await shot(page, '02-midfight.png');

  // --- wait for the bout to resolve
  let waited = 4200;
  while (waited < 45000) {
    const done = await page.evaluate(() => !document.getElementById('fight').disabled);
    if (done) break;
    await sleep(700); waited += 700;
  }
  const end = await page.evaluate(() => ({
    done: !document.getElementById('fight').disabled,
    resultShown: !document.getElementById('result').hidden,
    result: document.getElementById('result').textContent.trim(),
    hpA: parseInt(document.getElementById('hpValA').textContent),
    hpB: parseInt(document.getElementById('hpValB').textContent),
    feed: document.getElementById('feed').children.length,
  }));
  check(end.done, `bout never finished (waited ${waited}ms)`);
  check(end.resultShown, 'result card never shown');
  check(/WINS BY/.test(end.result), `result text unexpected: ${end.result}`);
  check(Math.min(end.hpA, end.hpB) < 100, 'nobody took damage');
  await shot(page, '03-result.png');

  const boutMs = waited;

  // --- other views
  const views = [['backtest', '04-backtest'], ['meta', '05-meta'], ['data', '06-data']];
  const viewState = {};
  for (const [v, name] of views) {
    await page.click(`.tab[data-view="${v}"]`);
    await sleep(v === 'backtest' ? 2500 : 700);
    viewState[v] = await page.evaluate((vv) => {
      const s = document.getElementById('view-' + vv);
      return { visible: s.classList.contains('on'), text: s.innerText.slice(0, 400), rows: s.querySelectorAll('tbody tr').length };
    }, v);
    await shot(page, name + '.png', { fullPage: true });
  }
  check(viewState.backtest.rows > 0, 'backtest table empty');
  check(!/-\s*$/.test((viewState.backtest.text.match(/^\S+/) || [''])[0]), 'backtest KPIs look unpopulated');
  check(viewState.meta.rows > 0, 'ranking table empty');

  const kpis = await page.evaluate(() => ({
    acc: document.getElementById('kAcc').textContent,
    base: document.getElementById('kBase').textContent,
    lift: document.getElementById('kLift').textContent,
    brier: document.getElementById('kBrier').textContent,
  }));
  check(kpis.acc !== '-' && /%/.test(kpis.acc), `accuracy KPI not filled: ${kpis.acc}`);

  // --- mobile
  await page.click('.tab[data-view="arena"]');
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true });
  await sleep(900);
  const mob = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    canvasW: document.getElementById('arena').getBoundingClientRect().width,
  }));
  check(mob.overflow <= 2, `horizontal overflow on mobile: ${mob.overflow}px`);
  await shot(page, '07-mobile.png');

  await browser.close();

  console.log('=== console errors ===');
  console.log(errors.length ? errors.join('\n') : '(none)');
  console.log('\n=== boot ===');
  console.log(JSON.stringify(boot, null, 1));
  console.log('\n=== fight ===');
  console.log(JSON.stringify({ ...end, boutMs }, null, 1));
  console.log('\n=== kpis ===');
  console.log(JSON.stringify(kpis, null, 1));
  console.log('\n=== mobile ===');
  console.log(JSON.stringify(mob, null, 1));
  console.log('\n=== RESULT ===');
  if (fail.length || errors.length) {
    console.log('FAIL');
    fail.forEach((f) => console.log(' - ' + f));
    errors.slice(0, 8).forEach((e) => console.log(' - console: ' + e));
    process.exit(1);
  }
  console.log('PASS - all checks green, screenshots in qa/');
})().catch((e) => { console.error('QA CRASH:', e); process.exit(1); });
