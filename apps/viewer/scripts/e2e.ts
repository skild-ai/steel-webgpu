import type { Page } from 'playwright-core';
import { HIDE_SUBGROUPS, R3F_URL, VANILLA_URL, launch, openPage, readProbe } from './browser';

// three r183+ deprecates THREE.Clock, which R3F 9.8 still creates for its root state.
const KNOWN_WARNINGS = [/THREE\.Clock: This module has been deprecated/];
const SCENE_TIMEOUT_MS = 30_000;
const LEAK_TOLERANCE_BYTES = 1 << 20;
// The same checks run against examples/vanilla-three with --vanilla; both viewers share the HUD's labels and roles.
const VIEWER_URL = process.argv.includes('--vanilla') ? VANILLA_URL : R3F_URL;

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const stat = (page: Page, key: string) => page.evaluate((k) => document.querySelector(`[data-stat="${k}"]`)?.textContent ?? '', key);
const simTime = async (page: Page) => parseFloat(await stat(page, 'time')) || 0;

async function waitForSimTime(page: Page, seconds: number) {
  await page.waitForFunction((s) => parseFloat(document.querySelector('[data-stat="time"]')?.textContent ?? '') > s, seconds, {
    timeout: SCENE_TIMEOUT_MS,
    polling: 100,
  });
}

const sceneTitles = new Map<string, string>();

async function readSceneTitles(page: Page) {
  const scenes: { name: string; title: string }[] = await page.evaluate(() => fetch('/assets/index.json').then((r) => r.json()));
  for (const { name, title } of scenes) sceneTitles.set(name, title);
  return scenes;
}

async function waitForTitle(page: Page, scene: string) {
  // A new session resets the HUD and only shows the scene title once running, so the time read after it is fresh.
  await page.waitForFunction((title) => document.querySelector('h1')?.textContent === title, sceneTitles.get(scene)!, {
    timeout: SCENE_TIMEOUT_MS,
    polling: 50,
  });
}

async function switchScene(page: Page, scene: string) {
  await page.selectOption('select[aria-label="Scene"]', scene);
  await waitForTitle(page, scene);
  await waitForSimTime(page, 0.5);
}

async function findGrabbablePoint(page: Page) {
  const box = (await page.locator('canvas').boundingBox())!;
  for (let y = 0.3; y < 0.9; y += 0.03) {
    for (let x = 0.3; x < 0.9; x += 0.03) {
      const point = { x: box.x + box.width * x, y: box.y + box.height * y };
      await page.mouse.move(point.x, point.y);
      await page.mouse.move(point.x + 1, point.y);
      await page.waitForTimeout(40);
      await page.mouse.move(point.x, point.y);
      if ((await page.evaluate(() => document.querySelector('canvas')!.style.cursor)) === 'grab') return point;
    }
  }
  return null;
}

async function allScenes(page: Page) {
  const scenes = await readSceneTitles(page);
  console.log(`${scenes.length} scenes in index.json`);
  let firstBytes = 0;
  for (const { name } of scenes) {
    const ok = await switchScene(page, name).then(
      () => true,
      () => false,
    );
    const probe = await readProbe(page);
    if (name === scenes[0].name) firstBytes = probe.liveBufferBytes;
    const fps = await stat(page, 'fps');
    const load = await stat(page, 'load');
    const stages = await page.evaluate(() => document.querySelector('[data-stat="load"]')?.getAttribute('title') ?? '');
    check(
      ok && probe.liveDevices === 1 && /^\d+ ms$/.test(load) && /fetch \d+, physics compile \d+/.test(stages),
      `${name}: runs (fps ${fps}, load ${load}, contacts ${await stat(page, 'contacts')}, ${await stat(page, 'metric')}), live devices ${probe.liveDevices}`,
    );
  }
  await switchScene(page, scenes[0].name);
  const probe = await readProbe(page);
  check(
    Math.abs(probe.liveBufferBytes - firstBytes) < LEAK_TOLERANCE_BYTES,
    `no GPU buffer leak after ${scenes.length} switches (${(firstBytes / 1e6).toFixed(1)} MB then ${(probe.liveBufferBytes / 1e6).toFixed(1)} MB)`,
  );
}

async function controls(page: Page) {
  await switchScene(page, 'dominoes');
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(600);
  const paused = await simTime(page);
  await page.waitForTimeout(800);
  check((await simTime(page)) === paused, 'pause stops sim time');
  await page.getByRole('button', { name: 'Play' }).click();
  await waitForSimTime(page, paused + 0.3);
  check(true, 'play resumes sim time');
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.waitForTimeout(400);
  check((await simTime(page)) < paused, 'reset rewinds sim time');

  const point = await findGrabbablePoint(page);
  check(point !== null, 'hovering a draggable body shows the grab cursor');
  if (point) {
    await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y - 40, { steps: 5 });
    await page.mouse.wheel(0, -200);
    check((await page.evaluate(() => document.querySelector('canvas')!.style.cursor)) === 'grabbing', 'dragging pulls the body');
    await page.mouse.up();
  }
}

async function compareToggle(page: Page) {
  await switchScene(page, 'overlap');
  const box = page.getByRole('checkbox', { name: 'compare', exact: true });
  check(await box.isChecked(), 'compare option starts on');
  await box.uncheck();
  await page.waitForTimeout(300);
  const before = await simTime(page);
  await waitForSimTime(page, before + 0.3);
  const probe = await readProbe(page);
  check(!(await box.isChecked()) && probe.liveDevices === 1, 'compare toggle rebuilds the sim and keeps running');
}

async function solverControls(page: Page) {
  await switchScene(page, 'dominoes');
  await page.selectOption('select[aria-label="substeps"]', '2');
  await page.waitForFunction(() => (document.querySelector('select[aria-label="substeps"]') as HTMLSelectElement).value === '2');
  const before = await simTime(page);
  await page.waitForTimeout(1500);
  check(
    new URL(page.url()).searchParams.get('ss') === '2' && (await simTime(page)) > 0 && (await simTime(page)) !== before,
    'substeps control rebuilds the sim and keeps it in the URL',
  );
  await page.getByRole('checkbox', { name: 'sleeping', exact: true }).check();
  await page.waitForTimeout(800);
  check(new URL(page.url()).searchParams.get('sleep') === '1', 'sleeping control applies');
  await page.getByRole('checkbox', { name: 'momentum', exact: true }).check();
  await page.waitForTimeout(800);
  check(new URL(page.url()).searchParams.get('nest') === '1', 'momentum control applies');
}

async function collisionView(page: Page) {
  await switchScene(page, 'bolt_sweep');
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(300);
  const canvas = page.locator('canvas').first();
  const drawn = await canvas.screenshot();
  const box = page.getByRole('checkbox', { name: 'collision', exact: true });
  await box.check();
  await page.waitForTimeout(500);
  const hulls = await canvas.screenshot();
  check(new URL(page.url()).searchParams.has('collision') && !hulls.equals(drawn), 'collision control draws the collision hulls and keeps it in the URL');
  await page.getByRole('button', { name: 'Play' }).click();
  await switchScene(page, 'dominoes');
  check((await box.isChecked()) && new URL(page.url()).searchParams.has('collision'), 'the collision view carries over to the next scene');
  await box.uncheck();
  await page.waitForTimeout(300);
  check(!new URL(page.url()).searchParams.has('collision'), 'unchecking collision returns to the scene visuals');
}

async function foldPanel(page: Page) {
  await page.getByRole('button', { name: 'Hide panel' }).click();
  const hidden = !(await page.locator('[data-stat="time"]').isVisible());
  await page.reload();
  await waitForSimTime(page, 0.2);
  const remembered = await page.getByRole('button', { name: 'Show panel' }).isVisible();
  await page.getByRole('button', { name: 'Show panel' }).click();
  check(hidden && remembered && (await page.locator('[data-stat="time"]').isVisible()), 'the panel folds to its title, stays folded on reload, and unfolds');
}

async function gallery(page: Page) {
  await page.getByRole('button', { name: 'Menu' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scene gallery' });
  check(await dialog.isVisible(), 'Menu opens the scene gallery');
  await page.waitForFunction(
    () => {
      const thumb = document.querySelector<HTMLCanvasElement>('[role="dialog"] canvas');
      if (!thumb) return false;
      // Sampling through a throwaway canvas keeps Chrome from warning about repeated getImageData on the thumbnail.
      const probe = document.createElement('canvas').getContext('2d')!;
      probe.drawImage(thumb, thumb.width / 2, thumb.height / 2, 1, 1, 0, 0, 1, 1);
      return probe.getImageData(0, 0, 1, 1).data[3] > 0;
    },
    undefined,
    { timeout: SCENE_TIMEOUT_MS },
  );
  check(true, 'gallery renders scene previews');
  const sections = await dialog.locator('h3').allTextContents();
  check(sections.length > 1 && sections.includes('Robot manipulation'), `gallery groups scenes by category (${sections.join(', ')})`);
  await dialog.locator('button[data-name="jenga"]').click();
  await waitForTitle(page, 'jenga');
  check(!(await dialog.isVisible()) && new URL(page.url()).searchParams.get('demo') === 'jenga', 'picking a gallery card switches the scene');
}

async function unsupported(browser: Awaited<ReturnType<typeof launch>>) {
  const problems: string[] = [];
  const page = await browser.newPage();
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  const sceneRequests: string[] = [];
  page.on('request', (r) => r.url().includes('scene.') && sceneRequests.push(r.url()));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  await page.goto(`${VIEWER_URL}?demo=bolt_sweep`);
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText);
  check(text.includes('needs a desktop browser with WebGPU'), 'unsupported browser sees the message');
  check(sceneRequests.length === 0, 'unsupported browser downloads no scene');
  check(problems.length === 0, 'unsupported browser logs no errors');
  await page.close();
}

console.log(`e2e on ${VIEWER_URL}${HIDE_SUBGROUPS ? ' without WebGPU subgroups' : ''}`);
const browser = await launch();
const consoleProblems: string[] = [];
const page = await openPage(browser, `${VIEWER_URL}?demo=bolt_sweep`, consoleProblems);
await waitForSimTime(page, 0.5);
await allScenes(page);
await controls(page);
await compareToggle(page);
await solverControls(page);
await collisionView(page);
await foldPanel(page);
await gallery(page);
await page.close();
await unsupported(browser);
await browser.close();

const unexpected = consoleProblems.filter((p) => !KNOWN_WARNINGS.some((w) => w.test(p)));
check(unexpected.length === 0, `console free of errors and unexpected warnings${unexpected.length ? `:\n  ${[...new Set(unexpected)].join('\n  ')}` : ''}`);
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
