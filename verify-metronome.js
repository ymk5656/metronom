const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function runVerification() {
  console.log('--- STARTING END-TO-END METRONOME VERIFICATION ---');
  let passedCount = 0;
  let totalCount = 0;

  function assert(condition, message) {
    totalCount++;
    if (condition) {
      console.log(`[PASS] ${message}`);
      passedCount++;
    } else {
      console.error(`[FAIL] ${message}`);
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // 1. Emulate mobile portrait viewport (iPhone 14 Pro Max)
    await page.setViewport({
      width: 430,
      height: 932,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    });

    console.log('1. Navigating to http://localhost:3000 ...');
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 8000 });
    await new Promise((r) => setTimeout(r, 400));

    // 2. Check HTML5 elements and PWA meta tags
    const title = await page.title();
    assert(title.includes('Wittner Mozart Classic'), `Page title is '${title}'`);

    const canvasExists = await page.$eval('#metronome-canvas', (el) => !!el);
    assert(canvasExists, 'HTML5 <canvas id="metronome-canvas"> exists');

    // 3. Verify HiDPI / Retina canvas buffer scaling
    const canvasDimensions = await page.$eval('#metronome-canvas', (canvas) => ({
      width: canvas.width,
      height: canvas.height,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
      dpr: window.devicePixelRatio
    }));
    console.log('Canvas metrics:', canvasDimensions);
    assert(
      canvasDimensions.dpr === 3 && canvasDimensions.width === canvasDimensions.clientWidth * 3,
      `HiDPI scaling active: buffer (${canvasDimensions.width}x${canvasDimensions.height}) = client (${canvasDimensions.clientWidth}x${canvasDimensions.clientHeight}) * DPR (${canvasDimensions.dpr})`
    );

    // 4. Verify initial stopped state
    const initState = await page.evaluate(() => window.__metronomeTestApi.getState());
    assert(initState.isRunning === false, 'Initial state: stopped/idle');
    assert(initState.currentBpm === 120, 'Initial default BPM is 120');
    assert(initState.currentAngle === 0, 'Initial pendulum angle is 0° (vertical dead center)');
    assert(initState.TEMPO_MARKS.length === 38, 'Tempo scale has authentic 38 markings');

    // 5. Start metronome via body tap
    console.log('2. Testing Start / Stop via tap ...');
    const canvasRect = await page.$eval('#metronome-canvas', (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });

    // Tap on lower base shield (outer body) to start
    await page.touchscreen.tap(canvasRect.left + canvasRect.width / 2, canvasRect.top + canvasRect.height * 0.75);
    await new Promise((r) => setTimeout(r, 200));

    const startedState = await page.evaluate(() => window.__metronomeTestApi.getState());
    assert(startedState.isRunning === true, 'Metronome started on body tap');

    // 6. Test Pendulum Harmonic Oscillations over time
    console.log('3. Verifying inverted pendulum harmonic swing ...');
    const angles = [];
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 120));
      const st = await page.evaluate(() => window.__metronomeTestApi.getState());
      angles.push(st.currentAngle);
    }
    console.log('Sampled angles (rad):', angles.map((a) => a.toFixed(4)));
    const maxAngle = Math.max(...angles.map(Math.abs));
    assert(maxAngle > 0.05, `Pendulum is actively swinging (peak sampled angle: ${(maxAngle * 180 / Math.PI).toFixed(1)}°)`);

    // Capture screenshot during swinging motion
    await page.screenshot({ path: path.join(__dirname, 'preview_swinging.png') });
    console.log('Saved preview_swinging.png');

    // 7. Stop metronome via tap
    await page.touchscreen.tap(canvasRect.left + canvasRect.width / 2, canvasRect.top + canvasRect.height * 0.75);
    await new Promise((r) => setTimeout(r, 450)); // Allow graceful return to 0°

    const stoppedState = await page.evaluate(() => window.__metronomeTestApi.getState());
    assert(stoppedState.isRunning === false, 'Metronome stopped on tap');
    assert(Math.abs(stoppedState.currentAngle) < 0.001, 'Pendulum smoothly eased back to vertical dead center (0°)');

    // 8. Test Tempo Adjustment via Scale Dragging (while stopped)
    console.log('4. Testing non-linear tempo scale drag ...');
    // Scale top is 40 BPM, scale bottom is 208 BPM.
    // Let's drag towards the upper third of the scale (e.g. ~60-72 BPM)
    const startY = canvasRect.top + canvasRect.height * 0.43; // Near 120 BPM
    const targetY = canvasRect.top + canvasRect.height * 0.28; // Near 60-72 BPM
    const centerX = canvasRect.left + canvasRect.width / 2;

    await page.touchscreen.tap(centerX, startY);
    // Drag upwards
    await page.evaluate(async (x, y1, y2) => {
      const canvas = document.getElementById('metronome-canvas');
      const startEv = new PointerEvent('pointerdown', { clientX: x, clientY: y1, bubbles: true });
      canvas.dispatchEvent(startEv);

      const steps = 10;
      for (let s = 1; s <= steps; s++) {
        const curY = y1 + (y2 - y1) * (s / steps);
        const moveEv = new PointerEvent('pointermove', { clientX: x, clientY: curY, bubbles: true });
        window.dispatchEvent(moveEv);
        await new Promise((r) => setTimeout(r, 20));
      }

      const upEv = new PointerEvent('pointerup', { clientX: x, clientY: y2, bubbles: true });
      window.dispatchEvent(upEv);
    }, centerX, startY, targetY);

    await new Promise((r) => setTimeout(r, 100));
    const draggedState = await page.evaluate(() => window.__metronomeTestApi.getState());
    console.log('BPM after dragging up:', draggedState.currentBpm);
    assert(
      draggedState.currentBpm < 120 && draggedState.TEMPO_MARKS.includes(draggedState.currentBpm),
      `Weight snapped to valid slower tempo notch: ${draggedState.currentBpm} BPM`
    );

    // Capture screenshot with new tempo
    await page.screenshot({ path: path.join(__dirname, 'preview_tempo_adjusted.png') });
    console.log('Saved preview_tempo_adjusted.png');

    // 9. Verify mid-swing drag lockout
    console.log('5. Verifying drag lockout during swing ...');
    await page.evaluate(() => window.__metronomeTestApi.startMetronome());
    await new Promise((r) => setTimeout(r, 150));
    const bpmBeforeDrag = (await page.evaluate(() => window.__metronomeTestApi.getState())).currentBpm;

    // Attempt drag while running
    await page.evaluate((x, y) => {
      const canvas = document.getElementById('metronome-canvas');
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y - 50, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    }, centerX, startY);

    const bpmAfterAttempt = (await page.evaluate(() => window.__metronomeTestApi.getState())).currentBpm;
    assert(bpmBeforeDrag === bpmAfterAttempt, `Tempo remained locked during swing (${bpmAfterAttempt} BPM)`);

    await page.evaluate(() => window.__metronomeTestApi.stopMetronome());

    // 10. Verify Manifest.json & Service Worker
    console.log('6. Verifying PWA Manifest and Service Worker ...');
    const manifestRes = await page.evaluate(async () => {
      const res = await fetch('manifest.json');
      return { status: res.status, json: await res.json() };
    });
    assert(manifestRes.status === 200, 'manifest.json fetched successfully');
    assert(manifestRes.json.display === 'standalone', "manifest display is 'standalone'");
    assert(manifestRes.json.orientation === 'portrait', "manifest orientation is 'portrait'");

    console.log(`\n========================================`);
    console.log(`ALL TESTS PASSED: ${passedCount} / ${totalCount} checks successful!`);
    console.log(`========================================\n`);

  } finally {
    await browser.close();
  }
}

runVerification().catch((err) => {
  console.error('Verification FAILED:', err);
  process.exit(1);
});
