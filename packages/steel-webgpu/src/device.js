// The browser or GPU lacks a capability the solver needs; nothing was downloaded or allocated.
export class UnsupportedError extends Error {
  name = 'UnsupportedError';
}

export async function initDevice() {
  if (!navigator.gpu) throw new UnsupportedError('WebGPU is not available in this browser');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new UnsupportedError('No WebGPU adapter is available');
  const L = adapter.limits;
  // Narrowphase and dense rows use 32-lane subgroups when the browser has them, else a serial fallback.
  const subgroups = adapter.features.has('subgroups') && adapter.info?.subgroupMaxSize >= 32;
  const features = ['timestamp-query'].filter((f) => adapter.features.has(f)).concat(subgroups ? ['subgroups'] : []);
  const device = await adapter.requestDevice({
    requiredFeatures: features,
    requiredLimits: {
      maxStorageBuffersPerShaderStage: Math.min(10, L.maxStorageBuffersPerShaderStage),
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: Math.min(1024, L.maxComputeInvocationsPerWorkgroup),
      maxComputeWorkgroupSizeX: Math.min(1024, L.maxComputeWorkgroupSizeX),
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
    },
  });
  device.lost.then((i) => { if (i.reason !== 'destroyed') console.error('device lost', i.message); });
  device.addEventListener('uncapturederror', (e) => console.error('webgpu error:', e.error.message));
  return device;
}

function point(poses, S, b, local) {
  // poses hold the COM; local is in the body (origin) frame.
  const c = [poses[b * 8], poses[b * 8 + 1], poses[b * 8 + 2]];
  const [x, y, z, w] = [poses[b * 8 + 4], poses[b * 8 + 5], poses[b * 8 + 6], poses[b * 8 + 7]];
  const com = S.bodies.com[b];
  const d = local.map((v, k) => v - com[k]);
  const t = [2 * (y * d[2] - z * d[1]), 2 * (z * d[0] - x * d[2]), 2 * (x * d[1] - y * d[0])];
  return [c[0] + d[0] + w * t[0] + (y * t[2] - z * t[1]), c[1] + d[1] + w * t[1] + (z * t[0] - x * t[2]), c[2] + d[2] + w * t[2] + (x * t[1] - y * t[0])];
}

// Count fasteners whose collision center lies inside the bin (the example's test_final check).
export function binCount(scene, poses) {
  const I = scene.json.info;
  const [lo, hi] = I.pile_bin_bounds;
  let n = 0;
  I.pile_bodies.forEach((b, i) => {
    const p = point(poses, scene.json, b, I.pile_piece_centers[i]);
    if (p.every((v, k) => v >= lo[k] && v <= hi[k])) n++;
  });
  return n;
}

// Demo progress shown in the HUD.
export function metric(scene, poses) {
  const I = scene.json.info;
  if (I.pile_bodies) return ['fasteners in bin', `${binCount(scene, poses)} / ${I.pile_bodies.length}`];
  if (I.plate_rack) {
    const c = point(poses, scene.json, I.tracked_body, I.plate_center_local);
    const inSlot = Math.abs(c[0] - I.plate_slot_x) < I.plate_slot_half_width;
    return ['plate height / in slot', `${c[2].toFixed(3)} m / ${inSlot ? 'yes' : 'no'}`];
  }
  const b = I.tracked_body;
  return b !== undefined ? ['object height', `${poses[b * 8 + 2].toFixed(3)} m`] : null;
}

export function demoName() {
  return new URLSearchParams(location.search).get('demo') || 'bolt_sweep';
}

// Solver options from the URL, e.g. ?reg=0 for the exact rigid contact law.
export function simOptions() {
  const q = new URLSearchParams(location.search);
  const o = {};
  if (q.has('reg')) o.regularization = parseFloat(q.get('reg'));
  if (q.has('warm')) o.warmStart = parseFloat(q.get('warm'));
  return o;
}
