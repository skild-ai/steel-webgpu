import { chromium, type Browser, type Page } from 'playwright-core';

export const VANILLA_URL = process.env.VANILLA_URL ?? 'http://localhost:5301/';
export const HIDE_SUBGROUPS = Boolean(process.env.NO_SUBGROUPS);
export const R3F_URL = process.env.R3F_URL ?? 'http://localhost:5199/';

/**
 * Runs in the page before any script: times every requestAnimationFrame callback (main-thread work per frame)
 * and tracks live GPU buffer bytes and devices, so a test can tell whether anything outlives its device.
 */
function instrumentPage(hideSubgroups: boolean) {
  if (hideSubgroups) {
    // Forces the engine's no-subgroup path, as on Safari or Firefox without the feature.
    const features = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, 'features')!.get!;
    Object.defineProperty(GPUAdapter.prototype, 'features', {
      get(this: GPUAdapter) {
        return new Set([...features.call(this)].filter((f) => f !== 'subgroups'));
      },
    });
  }
  const probe = { rafMs: 0, liveDevices: 0, liveBufferBytes: 0 };
  Object.assign(window, { __probe: probe });
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      const start = performance.now();
      cb(t);
      probe.rafMs += performance.now() - start;
    });
  const buffersOf = new WeakMap<GPUDevice, Map<GPUBuffer, number>>();
  const ownerOf = new WeakMap<GPUBuffer, GPUDevice>();
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, desc?: GPUDeviceDescriptor) {
    const device = await requestDevice.call(this, desc);
    buffersOf.set(device, new Map());
    probe.liveDevices++;
    return device;
  };
  const createBuffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function (this: GPUDevice, desc: GPUBufferDescriptor) {
    const buffer = createBuffer.call(this, desc);
    buffersOf.get(this)?.set(buffer, desc.size);
    ownerOf.set(buffer, this);
    probe.liveBufferBytes += desc.size;
    return buffer;
  };
  const destroyBuffer = GPUBuffer.prototype.destroy;
  GPUBuffer.prototype.destroy = function (this: GPUBuffer) {
    const live = ownerOf.get(this) && buffersOf.get(ownerOf.get(this)!);
    if (live?.has(this)) {
      probe.liveBufferBytes -= live.get(this)!;
      live.delete(this);
    }
    return destroyBuffer.call(this);
  };
  const destroyDevice = GPUDevice.prototype.destroy;
  GPUDevice.prototype.destroy = function (this: GPUDevice) {
    const live = buffersOf.get(this);
    if (live) {
      for (const size of live.values()) probe.liveBufferBytes -= size;
      buffersOf.delete(this);
      probe.liveDevices--;
    }
    return destroyDevice.call(this);
  };
}

export interface Probe {
  rafMs: number;
  liveDevices: number;
  liveBufferBytes: number;
}

export const readProbe = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __probe: Probe }).__probe }));

export async function launch(): Promise<Browser> {
  return chromium.launch({ channel: 'chrome', headless: !process.env.HEADFUL, args: ['--enable-unsafe-webgpu'] });
}

export async function openPage(browser: Browser, url: string, consoleProblems: string[], prepare?: (page: Page) => Promise<void>) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(instrumentPage, HIDE_SUBGROUPS);
  await prepare?.(page);
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleProblems.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => consoleProblems.push(`pageerror: ${e.message}`));
  // Callers wait for the viewer's own signals, which can come before the page's load event.
  await page.goto(url, { waitUntil: 'commit' });
  return page;
}
