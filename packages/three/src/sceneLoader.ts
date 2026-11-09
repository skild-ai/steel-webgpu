import { loadScene, type BinRange, type LoadedScene } from '@skild-ai/steel-webgpu';
import { layoutScene } from './bodyBatches';
import { geometryJobs, geometryKernels, meshFiles, type BuiltGeometry, type GeometryJob } from './renderGeometry';

/** A scene's render geometry by geometry key, built off the main thread. */
export type SceneGeometry = ReadonlyMap<string, BuiltGeometry>;

export interface SceneAssets {
  /** The scene's files, ready for `Sim.create`. */
  scene: Promise<LoadedScene>;
  geometry: Promise<SceneGeometry>;
}

type ToWorker = { kind: 'fetch'; id: number; url: string } | { kind: 'build'; id: number; jobs: GeometryJob[] };
type FromWorker =
  /** `files` holds the shared mesh files this thread has not been sent before, by absolute URL. */
  | { kind: 'files'; id: number; json: string; bin: ArrayBuffer; files: [string, ArrayBuffer][] }
  | { kind: 'built'; id: number; geometry: BuiltGeometry[] }
  | { kind: 'failed'; id: number; message: string };

interface WorkerScope {
  onmessage: ((event: { data: ToWorker }) => void) | null;
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
}

/** Runs in the worker from its source text, like `geometryKernels`: it may only use its arguments and globals. */
function geometryWorker(scope: WorkerScope, kernels: ReturnType<typeof geometryKernels>, filesOf: typeof meshFiles) {
  const scenes = new Map<number, { bin: ArrayBuffer; files: Map<string, ArrayBuffer> }>();
  // Shared mesh files are content-addressed, so they never go stale and each crosses to the page once.
  const shared = new Map<string, Promise<ArrayBuffer>>();
  const sent = new Set<string>();
  const fetchOk = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    return response;
  };
  const fail = (id: number, error: unknown) => scope.postMessage({ kind: 'failed', id, message: error instanceof Error ? error.message : String(error) });
  scope.onmessage = async ({ data }) => {
    if (data.kind === 'fetch') {
      try {
        const [json, bin] = await Promise.all([
          fetchOk(`${data.url}/scene.json`).then((r) => r.text()),
          fetchOk(`${data.url}/scene.bin`).then((r) => r.arrayBuffer()),
        ]);
        const paths = filesOf(JSON.parse(json).visuals);
        const urls = paths.map((path) => new URL(path, `${data.url}/`).href);
        for (const url of urls)
          if (!shared.has(url))
            shared.set(
              url,
              fetchOk(url).then((r) => r.arrayBuffer()),
            );
        const buffers = await Promise.all(urls.map((url) => shared.get(url)!));
        scenes.set(data.id, { bin, files: new Map(paths.map((path, k) => [path, buffers[k]])) });
        // The worker keeps the originals to build geometry from; the main thread takes copies.
        const copy = bin.slice(0);
        const fresh = urls.flatMap((url, k) => (sent.has(url) ? [] : [[url, buffers[k].slice(0)] as [string, ArrayBuffer]]));
        for (const [url] of fresh) sent.add(url);
        scope.postMessage({ kind: 'files', id: data.id, json, bin: copy, files: fresh }, [copy, ...fresh.map(([, b]) => b)]);
      } catch (error) {
        fail(data.id, error);
      }
      return;
    }
    const source = scenes.get(data.id)!;
    scenes.delete(data.id);
    try {
      const geometry = data.jobs.map((job) => kernels.build(source.bin, job, (ref) => kernels.meshData(source, ref)));
      scope.postMessage(
        { kind: 'built', id: data.id, geometry },
        geometry.flatMap((g) => [g.normal, g.position, g.uv].flatMap((a) => (a ? [a.buffer] : []))),
      );
    } catch (error) {
      fail(data.id, error);
    }
  };
}

function startWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  const source = `(${geometryWorker})(self, (${geometryKernels})(), ${meshFiles});`;
  try {
    return new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), { name: 'steel-scene-loader' });
  } catch {
    return null;
  }
}

function sceneFromFiles(base: string, json: string, bin: ArrayBuffer, sharedFiles: ReadonlyMap<string, ArrayBuffer>): LoadedScene {
  const parsed = JSON.parse(json);
  const baseUrl = `${new URL(base, document.baseURI).href}/`;
  const files = new Map(meshFiles(parsed.visuals).map((path) => [path, sharedFiles.get(new URL(path, baseUrl).href)!]));
  const { meshData } = geometryKernels();
  return {
    json: parsed,
    bin,
    base,
    f32: (r: BinRange) => new Float32Array(bin, r.off, r.n),
    u32: (r: BinRange) => new Uint32Array(bin, r.off, r.n),
    mesh: (ref) => meshData({ bin, files }, ref),
  };
}

const geometryBytes = (geometry: SceneGeometry) =>
  [...geometry.values()].reduce((n, g) => n + [g.normal, g.position, g.uv].reduce((m, a) => m + (a?.byteLength ?? 0), 0), 0);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  const settle: Partial<Deferred<T>> = {};
  const promise = new Promise<T>((resolve, reject) => Object.assign(settle, { resolve, reject }));
  return { promise, resolve: settle.resolve!, reject: settle.reject! };
}

interface Pending {
  base: string;
  scene: Deferred<LoadedScene>;
  geometry: Deferred<SceneGeometry>;
}

interface Cached extends SceneAssets {
  bytes: number;
}

/**
 * Fetches scene folders and builds their render geometry in a worker, keeping both for the session so a scene loads
 * again without either. The least recently used scenes are dropped once the cache outgrows `budgetBytes`.
 */
export class SceneLoader {
  private readonly worker = startWorker();
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<string, Cached>();
  private readonly sharedFiles = new Map<string, ArrayBuffer>();
  private nextId = 0;

  constructor(private readonly budgetBytes = 256 << 20) {
    if (this.worker) this.worker.onmessage = ({ data }: MessageEvent<FromWorker>) => this.receive(data);
  }

  /** The scene folder at `base` (holding scene.json and scene.bin), from the cache or freshly loaded. */
  load(base: string): SceneAssets {
    const cached = this.cache.get(base);
    if (cached) {
      this.cache.delete(base);
      this.cache.set(base, cached);
      return cached;
    }
    const assets: Cached = { ...(this.worker ? this.loadInWorker(base, this.worker) : this.loadHere(base)), bytes: 0 };
    this.cache.set(base, assets);
    Promise.all([assets.scene, assets.geometry]).then(
      ([scene, geometry]) => {
        assets.bytes = scene.bin.byteLength + geometryBytes(geometry);
        this.evict(base);
      },
      () => this.cache.get(base) === assets && this.cache.delete(base),
    );
    return assets;
  }

  private loadInWorker(base: string, worker: Worker): SceneAssets {
    const id = this.nextId++;
    const pending: Pending = { base, scene: deferred(), geometry: deferred() };
    // A failed fetch fails both; nobody may be waiting on the geometry yet.
    pending.geometry.promise.catch(() => undefined);
    this.pending.set(id, pending);
    worker.postMessage({ kind: 'fetch', id, url: new URL(base, document.baseURI).href } satisfies ToWorker);
    return { scene: pending.scene.promise, geometry: pending.geometry.promise };
  }

  private loadHere(base: string): SceneAssets {
    const scene = loadScene(base);
    const geometry = scene.then((s) => buildGeometry(s));
    geometry.catch(() => undefined);
    return { scene, geometry };
  }

  private receive(message: FromWorker) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.kind === 'failed') {
      this.pending.delete(message.id);
      const error = new Error(message.message);
      pending.scene.reject(error);
      pending.geometry.reject(error);
    } else if (message.kind === 'files') {
      try {
        for (const [url, buffer] of message.files) this.sharedFiles.set(url, buffer);
        const scene = sceneFromFiles(pending.base, message.json, message.bin, this.sharedFiles);
        this.worker!.postMessage({ kind: 'build', id: message.id, jobs: geometryJobs(layoutScene(scene.json)) } satisfies ToWorker);
        pending.scene.resolve(scene);
      } catch (error) {
        this.pending.delete(message.id);
        pending.scene.reject(error);
        pending.geometry.reject(error);
      }
    } else {
      this.pending.delete(message.id);
      pending.geometry.resolve(new Map(message.geometry.map((g) => [g.key, g])));
    }
  }

  private evict(keep: string) {
    let total = [...this.cache.values()].reduce((n, c) => n + c.bytes, 0);
    for (const [base, cached] of this.cache) {
      if (total <= this.budgetBytes) break;
      if (base === keep || cached.bytes === 0) continue;
      this.cache.delete(base);
      total -= cached.bytes;
    }
  }
}

/** Render geometry built on the calling thread, for scenes that never went through a SceneLoader. */
export function buildGeometry(scene: LoadedScene): SceneGeometry {
  const { build } = geometryKernels();
  return new Map(geometryJobs(layoutScene(scene.json)).map((job) => [job.key, build(scene.bin, job, scene.mesh)]));
}

let shared: SceneLoader | null = null;

/** The page's scene loader, started on first use. */
export const sceneLoader = () => (shared ??= new SceneLoader());

/** Starts loading the scene folder at `base` into the session cache, e.g. on hover, so opening it later is quicker. */
export function prefetchScene(base: string) {
  sceneLoader().load(base);
}
