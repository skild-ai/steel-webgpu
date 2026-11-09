import {
  BatchedMesh,
  Box3,
  Box3Helper,
  BufferAttribute,
  Color,
  type DirectionalLight,
  BufferGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Line,
  LineBasicNodeMaterial,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Sphere,
  SphereGeometry,
  Vector3,
  RepeatWrapping,
  TextureLoader,
  SRGBColorSpace,
  type Material,
  type Texture,
  type Object3D,
} from 'three/webgpu';
import { Fn, instancedArray, int, select, uniform, vertexIndex } from 'three/tsl';
import { collisionLayout, geometryKey, layoutScene, type BodyPiece, type GeometrySource, type PieceBatch, type SceneLayout } from './bodyBatches';
import {
  batchedPiecePosition,
  bodyMaterial,
  bodyPose,
  createPosedMaterial,
  instancedPieceColor,
  PIECE_COLOR,
  PIECE_OFFSET,
  PIECE_ROTATION,
  posedPiecePosition,
  rotateByQuat,
  srgb,
  VEC4_PER_PLACEMENT,
} from './posedMaterial';
import { checkerDataTexture, studioLights } from './studio';
import { VEC4_PER_POSE } from './poseBridge';
import type { DragState, LoadedScene, Transform, Vec3 } from '../index';
import { geometryJob, geometryKernels, type BuiltGeometry } from './renderGeometry';
import type { SceneGeometry } from './sceneLoader';

const DRAG_COLOR = 0xffd54f;

function pieceGeometry(scene: LoadedScene, source: GeometrySource, built: BuiltGeometry) {
  const g = new BufferGeometry();
  if (built.position) {
    g.setAttribute('position', new BufferAttribute(built.position, 3));
    if (built.uv) g.setAttribute('uv', new BufferAttribute(built.uv, 2));
  } else if (source.kind === 'mesh') {
    const { pos, idx, uv } = scene.mesh(source.mesh);
    g.setAttribute('position', new BufferAttribute(pos, 3));
    if (uv) g.setAttribute('uv', new BufferAttribute(uv, 2));
    g.setIndex(new BufferAttribute(idx, 1));
  }
  g.setAttribute('normal', new BufferAttribute(built.normal, 3));
  return g;
}

const materialKey = (color: Vec3, texture?: string) => `${color.join(',')}|${texture ?? ''}`;
const WHITE: Vec3 = [1, 1, 1];

// 1 m checker tiles (a 2 m texture period) out to where the fog has taken over.
function floorGeometry() {
  const plane = new PlaneGeometry(1000, 1000);
  const uv = plane.attributes.uv.array as Float32Array;
  for (let i = 0; i < uv.length; i++) uv[i] *= 500;
  return plane;
}

const place = (obj: Object3D, xf: Transform) => {
  obj.position.set(xf[0], xf[1], xf[2]);
  obj.quaternion.set(xf[3], xf[4], xf[5], xf[6]);
};

// Posed pieces are placed on the GPU, so their CPU bounds mean nothing; a fixed sphere spares three computing them.
const PLACED_ON_GPU = new Sphere();

const placementOf = (piece: BodyPiece) => [...piece.offset, piece.body, ...piece.rotation];

function instancedPieces(base: BufferGeometry, batch: PieceBatch) {
  const g = new InstancedBufferGeometry();
  g.setIndex(base.index);
  for (const [name, attr] of Object.entries(base.attributes)) g.setAttribute(name, attr);
  const offsets = new Float32Array(batch.pieces.length * 4);
  const rotations = new Float32Array(batch.pieces.length * 4);
  const colors = new Float32Array(batch.pieces.length * 3);
  const color = new Color();
  batch.pieces.forEach((p, i) => {
    offsets.set([...p.offset, p.body], i * 4);
    rotations.set(p.rotation, i * 4);
    colors.set(srgb(p.color, color).toArray(), i * 3);
  });
  g.setAttribute(PIECE_OFFSET, new InstancedBufferAttribute(offsets, 4));
  g.setAttribute(PIECE_ROTATION, new InstancedBufferAttribute(rotations, 4));
  g.setAttribute(PIECE_COLOR, new InstancedBufferAttribute(colors, 3));
  g.instanceCount = batch.pieces.length;
  g.boundingSphere = PLACED_ON_GPU;
  return g;
}

/** The attributes a BatchedMesh takes from a piece: all its geometries need the same ones, and an index. */
function batchable(base: BufferGeometry) {
  const g = new BufferGeometry();
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('normal', base.attributes.normal);
  g.setIndex(
    base.index ??
      new BufferAttribute(
        Uint32Array.from({ length: base.attributes.position.count }, (_, i) => i),
        1,
      ),
  );
  return g;
}

/** Unique pieces as one BatchedMesh with a color per instance, each placed on the GPU from its entry in `placements`. */
function batchedPieces(parts: { base: BufferGeometry; piece: BodyPiece }[], material: Material, placements: Float32Array) {
  const geometries = parts.map(({ base }) => batchable(base));
  const vertexCount = geometries.reduce((n, g) => n + g.attributes.position.count, 0);
  const indexCount = geometries.reduce((n, g) => n + g.index!.count, 0);
  const mesh = new BatchedMesh(parts.length, vertexCount, indexCount, material);
  mesh.sortObjects = false;
  mesh.perObjectFrustumCulled = false;
  mesh.frustumCulled = false;
  const color = new Color();
  parts.forEach(({ piece }, i) => {
    const instance = mesh.addInstance(mesh.addGeometry(geometries[i]));
    mesh.setColorAt(instance, srgb(piece.color, color));
    placements.set(placementOf(piece), instance * 4 * VEC4_PER_PLACEMENT);
  });
  mesh.geometry.boundingSphere = PLACED_ON_GPU;
  return mesh;
}

/**
 * The three.js side of a scene: body pieces drawn as instanced meshes and one BatchedMesh placed
 * on the GPU from `poses`, static hulls, ground planes, the bin outline, lights, and the drag line. `pickBodies` mirrors the
 * bodies on the CPU for raycasting from an occasional pose readback.
 */
export class SceneGraph {
  readonly root = new Group();
  readonly pickBodies: Group[] = [];
  readonly renderPoses;
  private pickPoses: Float32Array | null = null;
  private readonly geometries = new Set<BufferGeometry>();
  private readonly materials = new Set<Material>();
  private readonly textures = new Map<string, Texture>();
  private readonly textureLoads: Promise<void>[] = [];
  private readonly storage: { dispose(): void }[] = [];
  private readonly batched: BatchedMesh[] = [];
  private readonly dragLine: Line;
  private readonly dragDot: Mesh;
  private readonly dragBody = uniform(0, 'int');
  private readonly dragLocal = uniform(new Vector3());
  private readonly dragTarget = uniform(new Vector3());
  /** The drawn scene, and the collision view of its convex hulls, built on first use. */
  private readonly looks = new Group();
  private collision: Group | null = null;
  private readonly posedPosition;
  private readonly prebuilt?: SceneGeometry;
  private kernels?: ReturnType<typeof geometryKernels>;
  private readonly baseGeometries = new Map<string, BufferGeometry>();
  private readonly instancedMaterials = new Map<string, MeshStandardNodeMaterial>();
  private readonly staticMaterials = new Map<string, MeshStandardNodeMaterial>();
  private pickMaterial?: MeshBasicNodeMaterial;

  /** `geometry` is the scene's prebuilt render geometry, e.g. from a SceneLoader; without it, it is built here. */
  constructor(
    private readonly scene: LoadedScene,
    cameraTarget: Vec3,
    geometry?: SceneGeometry,
  ) {
    const S = scene.json;
    const layout = layoutScene(S);
    this.renderPoses = instancedArray(S.bodies.count * VEC4_PER_POSE, 'vec4').toReadOnly();
    this.posedPosition = posedPiecePosition(this.renderPoses);
    this.prebuilt = geometry;

    this.root.add(...studioLights(cameraTarget));
    this.root.add(this.looks);
    for (let b = 0; b < S.bodies.count; b++) this.pickBodies.push(new Group());
    this.addPieces(layout, this.looks, true);
    let floorMaterial: MeshStandardNodeMaterial | null = null;
    const floor = () => (floorMaterial ??= this.own(new MeshStandardNodeMaterial({ map: this.ownTexture(checkerDataTexture()), roughness: 1, metalness: 0 })));
    for (const xf of layout.planes) {
      const ground = new Mesh(this.ownGeometry(floorGeometry()), floor());
      place(ground, xf);
      ground.receiveShadow = true;
      this.root.add(ground);
    }
    if (S.info.pile_bin_bounds) {
      const [lo, hi] = S.info.pile_bin_bounds;
      const bin = new Box3Helper(new Box3(new Vector3(...lo), new Vector3(...hi)), 0x4fc3f7);
      this.geometries.add(bin.geometry);
      this.materials.add(bin.material as Material);
      this.root.add(bin);
    }

    this.dragLine = this.createDragLine();
    this.dragDot = new Mesh(this.ownGeometry(new SphereGeometry(0.006)), this.own(new MeshBasicNodeMaterial({ color: DRAG_COLOR, depthTest: false })));
    this.dragDot.renderOrder = 10;
    this.dragDot.visible = false;
    this.root.add(this.dragDot);
  }

  /** Draws the convex hulls the solver collides, one flat tint per body, in place of the scene's visuals. */
  setCollisionView(on: boolean) {
    if (on && !this.collision) {
      this.collision = new Group();
      this.addPieces(collisionLayout(this.scene.json), this.collision, false);
      this.root.add(this.collision);
    }
    this.looks.visible = !on;
    if (this.collision) this.collision.visible = on;
  }

  get collisionView() {
    return this.collision?.visible ?? false;
  }

  /** Body pieces as instanced meshes and one BatchedMesh placed on the GPU, statics placed once; `pickable` mirrors them for picking. */
  private addPieces(layout: SceneLayout, parent: Group, pickable: boolean) {
    const S = this.scene.json;
    const addPosed = (mesh: Mesh | BatchedMesh) => {
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      parent.add(mesh);
    };
    const addPickable = (base: BufferGeometry, piece: BodyPiece) => {
      if (!pickable) return;
      const pick = new Mesh(base, (this.pickMaterial ??= this.own(new MeshBasicNodeMaterial())));
      const com = S.bodies.com[piece.body];
      pick.position.set(piece.offset[0] + com[0], piece.offset[1] + com[1], piece.offset[2] + com[2]);
      pick.quaternion.set(...piece.rotation);
      pick.userData.body = piece.body;
      this.pickBodies[piece.body].add(pick);
    };
    for (const batch of layout.batches) {
      const base = this.geometryOf(batch.source);
      addPosed(new Mesh(this.ownGeometry(instancedPieces(base, batch)), this.instancedMaterial(batch.texture)));
      for (const piece of batch.pieces) addPickable(base, piece);
    }
    if (layout.unique.length > 0) {
      const parts = layout.unique.map(({ source, piece }) => ({ base: this.geometryOf(source), piece }));
      const placements = new Float32Array(parts.length * 4 * VEC4_PER_PLACEMENT);
      const placementBuffer = instancedArray(placements, 'vec4').toReadOnly();
      this.storage.push(placementBuffer.value);
      const material = this.own(createPosedMaterial(WHITE, null, batchedPiecePosition(this.renderPoses, placementBuffer)));
      const batched = batchedPieces(parts, material, placements);
      this.batched.push(batched);
      addPosed(batched);
      for (const { base, piece } of parts) addPickable(base, piece);
    }
    for (const piece of layout.statics) {
      const material = this.cached(this.staticMaterials, materialKey(piece.color, piece.texture), () => bodyMaterial(piece.color, this.texture(piece.texture)));
      const mesh = new Mesh(this.geometryOf(piece.source), material);
      mesh.castShadow = mesh.receiveShadow = true;
      place(mesh, piece.xf);
      parent.add(mesh);
    }
  }

  private geometryOf(source: GeometrySource) {
    const key = geometryKey(source);
    let g = this.baseGeometries.get(key);
    if (!g) {
      const built = this.prebuilt?.get(key) ?? (this.kernels ??= geometryKernels()).build(this.scene.bin, geometryJob(source), this.scene.mesh);
      g = pieceGeometry(this.scene, source, built);
      this.baseGeometries.set(key, g);
      this.geometries.add(g);
    }
    return g;
  }

  private cached(cache: Map<string, MeshStandardNodeMaterial>, key: string, make: () => MeshStandardNodeMaterial) {
    let m = cache.get(key);
    if (!m) {
      m = make();
      cache.set(key, m);
      this.materials.add(m);
    }
    return m;
  }

  private instancedMaterial(texture?: string) {
    return this.cached(this.instancedMaterials, texture ?? '', () => {
      const material = createPosedMaterial(WHITE, this.texture(texture), this.posedPosition);
      material.colorNode = instancedPieceColor;
      return material;
    });
  }

  initialPoses(poses: Float32Array) {
    this.renderPoses.value.array.set(poses.subarray(0, this.renderPoses.value.array.length));
    this.renderPoses.value.needsUpdate = true;
  }

  bodyCom(body: number) {
    return new Vector3(...this.scene.json.bodies.com[body]);
  }

  /** Moves the CPU pick bodies to `poses` (COM position and quaternion, 8 floats per body), as Viewer.update does. */
  setPickPoses(poses: Float32Array) {
    if (poses === this.pickPoses) return;
    this.pickPoses = poses;
    const com = new Vector3();
    const q = new Quaternion();
    this.pickBodies.forEach((g, b) => {
      const o = b * 8;
      q.set(poses[o + 4], poses[o + 5], poses[o + 6], poses[o + 7]);
      com.set(...this.scene.json.bodies.com[b]).applyQuaternion(q);
      g.position.set(poses[o] - com.x, poses[o + 1] - com.y, poses[o + 2] - com.z);
      g.quaternion.copy(q);
      g.updateMatrixWorld(true);
    });
  }

  showDrag(drag: DragState | null) {
    this.dragLine.visible = this.dragDot.visible = drag !== null;
    if (!drag) return;
    this.dragBody.value = drag.body;
    this.dragLocal.value.set(drag.local[0], drag.local[1], drag.local[2]);
    this.dragTarget.value.set(drag.target[0], drag.target[1], drag.target[2]);
    this.dragDot.position.copy(this.dragTarget.value);
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    for (const b of this.batched) b.dispose();
    for (const buffer of this.storage) buffer.dispose();
    this.renderPoses.value.dispose();
    this.root.traverse((o) => (o as Partial<DirectionalLight>).shadow?.dispose());
  }

  private createDragLine() {
    const geometry = this.ownGeometry(new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]));
    const material = this.own(new LineBasicNodeMaterial({ color: DRAG_COLOR, depthTest: false }));
    material.positionNode = Fn(() => {
      const { com, quat } = bodyPose(this.renderPoses, this.dragBody);
      const grab = com.add(rotateByQuat(quat, this.dragLocal));
      return select(vertexIndex.equal(int(0)), grab, this.dragTarget);
    })();
    const line = new Line(geometry, material);
    line.renderOrder = 10;
    line.visible = false;
    line.frustumCulled = false;
    this.root.add(line);
    return line;
  }

  /** Resolves once the scene's textures have loaded or failed, e.g. before a one-off preview render. */
  texturesReady(): Promise<void> {
    return Promise.all(this.textureLoads).then(() => undefined);
  }

  private texture(path: string | undefined): Texture | null {
    if (!path) return null;
    const url = `${this.scene.base}/${path}`;
    let tex = this.textures.get(url);
    if (!tex) {
      let settle!: () => void;
      this.textureLoads.push(new Promise<void>((resolve) => (settle = resolve)));
      tex = new TextureLoader().load(url, settle, undefined, settle);
      tex.colorSpace = SRGBColorSpace;
      // Newton's UVs tile, e.g. a table's wood grain.
      tex.wrapS = tex.wrapT = RepeatWrapping;
      tex.anisotropy = 8;
      this.textures.set(url, tex);
    }
    return tex;
  }

  private ownTexture(texture: Texture) {
    this.textures.set(texture.uuid, texture);
    return texture;
  }

  private own<M extends Material>(material: M) {
    this.materials.add(material);
    return material;
  }

  private ownGeometry<G extends BufferGeometry>(geometry: G) {
    this.geometries.add(geometry);
    return geometry;
  }
}
