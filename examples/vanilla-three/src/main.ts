import { sceneLoader } from '@steel-webgpu/three';
import { initDevice, UnsupportedError, type SceneEntry } from 'steel-webgpu';
import { Gallery } from './gallery';
import { Hud, PLAIN_TITLE } from './hud';
import { readQuery, setQuery, tuningFlags } from './query';
import { Stage } from './stage';
import { Viewer, type ViewerControls } from './viewer';
import './style.css';

const ASSETS_BASE = `${import.meta.env.BASE_URL}assets`;

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;

function showNotice(text: string) {
  const overlay = document.querySelector<HTMLDivElement>('#overlay')!;
  overlay.hidden = false;
  overlay.textContent = text;
}

async function main() {
  const query = readQuery();
  // Started while the device is requested, so the first scene fetch does not wait for the loader's worker.
  sceneLoader();
  const [device, scenes] = await Promise.all([initDevice(), fetch(`${ASSETS_BASE}/index.json`).then((r) => r.json() as Promise<SceneEntry[]>)]);
  const stage = await Stage.create(canvas, device);

  let scene = query.scene;
  let controls: ViewerControls = { running: !query.paused, compareOff: query.compareOff, tuning: query.tuning };
  const update = (patch: Partial<ViewerControls>) => {
    controls = { ...controls, ...patch };
    viewer.setControls(controls);
  };
  const pick = (name: string) => {
    if (gallery.isOpen) showGallery(false);
    if (name === scene) return;
    scene = name;
    controls = { running: true, compareOff: false, tuning: {} };
    setQuery({ demo: name, without: null, ...tuningFlags({}) });
    hud.showPicked(name);
    document.title = `${hud.titleOf(name)} · ${PLAIN_TITLE}`;
    void viewer.open(name, controls);
  };
  const showGallery = (open: boolean) => {
    if (open) gallery.open(scene);
    else gallery.hide();
    viewer.suspend(open);
    setQuery({ gallery: open ? '' : null });
  };

  const hud = new Hud({
    pick,
    menu: () => showGallery(true),
    togglePlay: () => update({ running: !controls.running }),
    reset: () => viewer.reset(),
    setCompare: (enabled) => {
      update({ compareOff: !enabled });
      setQuery({ without: enabled ? null : '' });
    },
    retune: (tuning) => {
      update({ tuning });
      setQuery(tuningFlags(tuning));
    },
    setCollision: (collision) => {
      viewer.setCollision(collision);
      setQuery({ collision: collision ? '' : null });
    },
  });
  const gallery = new Gallery(scenes, ASSETS_BASE, pick, () => showGallery(false));
  const viewer = new Viewer(stage, hud, ASSETS_BASE, query.solver, controls);

  hud.listScenes(scenes, scene);
  hud.showCollision(query.collision);
  viewer.setCollision(query.collision);
  document.title = `${hud.titleOf(scene)} · ${PLAIN_TITLE}`;
  void viewer.open(scene, controls);
  if (query.gallery) showGallery(true);
}

main().catch((error: unknown) => {
  if (error instanceof UnsupportedError) {
    showNotice(`This live demo needs a desktop browser with WebGPU subgroups, such as a recent Chrome or Edge. ${error.message}.`);
    return;
  }
  showNotice('The viewer failed to start; see the console.');
  console.error(error);
});
