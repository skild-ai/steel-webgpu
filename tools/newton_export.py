# SPDX-License-Identifier: Apache-2.0
"""Export a Newton ``Model`` to the scene format of the WebGPU Steel port.

    from newton_export import export_model
    export_model(model, "assets/scenes/my_scene", name="my_scene")

Bodies, joints (fixed, revolute, prismatic, ball; free roots become free bodies),
drives, limits, damping and friction, collision filters, collision shapes as convex
hulls (spheres and capsules also keep their analytic form) and visual meshes.
"""

import json
import math
from pathlib import Path

import numpy as np
import newton

CYL_SEGMENTS = 24


def hull_of(points):
    """Convex hull as vertices + polygon faces (coplanar triangles merged)."""
    from scipy.spatial import ConvexHull

    points = np.asarray(points, dtype=np.float64)
    hull = ConvexHull(points)
    used = np.unique(hull.simplices)
    remap = {int(v): i for i, v in enumerate(used)}
    verts = points[used]
    planes = []  # (normal, offset, [triangles])
    for tri, eq in zip(hull.simplices, hull.equations, strict=True):
        n, d = eq[:3], -eq[3]
        for p in planes:
            if np.dot(p[0], n) > 1.0 - 1e-6 and abs(p[1] - d) < 1e-6:
                p[2].append(tri)
                break
        else:
            planes.append([n, d, [tri]])
    faces = []
    for n, d, tris in planes:
        ids = sorted({remap[int(v)] for t in tris for v in t})
        c = verts[ids].mean(axis=0)
        u = verts[ids[0]] - c
        u /= np.linalg.norm(u) + 1e-30
        w = np.cross(n, u)
        ids.sort(key=lambda i: math.atan2(np.dot(verts[i] - c, w), np.dot(verts[i] - c, u)))
        faces.append({"n": n.tolist(), "d": float(d), "v": ids})
    return verts, faces


def shape_points(model, s):
    t = int(model.shape_type.numpy()[s])
    scale = model.shape_scale.numpy()[s]
    G = newton.GeoType
    if t == G.BOX:
        hx, hy, hz = scale
        return np.array([[sx * hx, sy * hy, sz * hz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
    if t == G.CYLINDER:
        r, h = scale[0], scale[1]
        a = np.arange(CYL_SEGMENTS) * 2 * math.pi / CYL_SEGMENTS
        ring = np.column_stack([r * np.cos(a), r * np.sin(a)])
        return np.vstack([np.column_stack([ring, np.full(len(a), z)]) for z in (-h, h)])
    if t == G.CAPSULE:
        r, h = scale[0], scale[1]
        pts = []
        for z0, sgn in ((h, 1), (-h, -1)):
            for el in np.linspace(0, math.pi / 2, 4):
                for az in np.arange(12) * 2 * math.pi / 12:
                    pts.append([r * math.cos(el) * math.cos(az), r * math.cos(el) * math.sin(az), z0 + sgn * r * math.sin(el)])
        return np.unique(np.round(np.array(pts), 9), axis=0)
    if t == G.SPHERE:
        r = scale[0]
        pts = []
        for el in np.linspace(-math.pi / 2, math.pi / 2, 7):
            for az in np.arange(12) * 2 * math.pi / 12:
                pts.append([r * math.cos(el) * math.cos(az), r * math.cos(el) * math.sin(az), r * math.sin(el)])
        return np.unique(np.round(np.array(pts), 9), axis=0)
    if t in (G.CONVEX_MESH, G.MESH):
        src = model.shape_source[s]
        return np.asarray(src.vertices, dtype=np.float64) * np.asarray(scale)
    raise ValueError(f"unsupported shape type {t}")


def export_model(
    model, out, *, name, solver=None, targets=None, driven=0, integral_count=0, control=None, info=None, twists=None,
):
    """Write ``scene.json`` and ``scene.bin`` for ``model`` into ``out``.

    ``twists`` (bodies x 6: COM linear velocity, angular velocity, world) sets initial free-body
    velocities. ``targets`` (frames x driven, 60 Hz) optionally drives the first ``driven`` dofs of the
    first articulation (interpolated per substep);
    ``control`` names a per-substep controller; ``info`` is free-form
    scene metadata kept in the JSON.
    """
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    info = dict(info or {})
    solver = {"substeps": 4, "iterations": 12, "enable_joint_friction": False, "enable_joint_velocity_limits": False, "enable_joint_limits": True, **(solver or {})}
    if targets is None:
        targets = np.zeros((0, max(driven, 1)), dtype=np.float32)
    G = newton.GeoType
    blob = bytearray()

    def put(arr, dtype):
        nonlocal blob
        a = np.ascontiguousarray(arr, dtype=dtype)
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        blob += a.tobytes()
        return {"off": off, "n": int(a.size)}

    state = model.state()
    newton.eval_fk(model, model.joint_q, model.joint_qd, state)
    body_q = state.body_q.numpy()
    body_twist = (np.zeros((model.body_count, 6)) if twists is None else np.asarray(twists, dtype=np.float64)).tolist()
    bodies = {
        "count": model.body_count,
        "mass": model.body_mass.numpy().tolist(),
        "inertia": model.body_inertia.numpy().reshape(-1, 9).tolist(),
        "com": model.body_com.numpy().tolist(),
        "q": body_q.tolist(),
        "twist": body_twist,
        "label": list(model.body_label),
        "kinematic": ((model.body_flags.numpy() & int(newton.BodyFlags.KINEMATIC)) != 0).tolist() if getattr(model, "body_flags", None) is not None else [],
        "no_gravity": model.body_disable_gravity.numpy().astype(bool).tolist() if getattr(model, "body_disable_gravity", None) is not None else [],
    }
    # Steel's per-body attributes (steel:rigid_body_*), when the model registered them.
    steel = getattr(model, "steel", None)
    for key in ("angular_damping", "max_linear_velocity", "max_angular_velocity", "max_depenetration_velocity"):
        values = getattr(steel, f"rigid_body_{key}", None) if steel is not None else None
        if values is not None:
            bodies[key] = [float(v) if np.isfinite(v) else None for v in values.numpy()]
    jt = model.joint_type.numpy()
    joints = {
        "count": model.joint_count,
        "type": jt.tolist(),
        "parent": model.joint_parent.numpy().tolist(),
        "child": model.joint_child.numpy().tolist(),
        "X_p": model.joint_X_p.numpy().tolist(),
        "X_c": model.joint_X_c.numpy().tolist(),
        "axis": model.joint_axis.numpy().tolist(),
        "dof_dim": model.joint_dof_dim.numpy().tolist(),
        "mimic_joint": getattr(model, "joint_mimic_joint", None).numpy().tolist() if getattr(model, "joint_mimic_joint", None) is not None else [],
        "mimic_coeffs": model.joint_mimic_coeffs.numpy().tolist() if getattr(model, "joint_mimic_coeffs", None) is not None else [],
        "q_start": model.joint_q_start.numpy().tolist(),
        "qd_start": model.joint_qd_start.numpy().tolist(),
        "articulation": model.joint_articulation.numpy().tolist(),
        "q": model.joint_q.numpy().tolist(),
        "armature": model.joint_armature.numpy().tolist(),
        "ke": model.joint_target_ke.numpy().tolist(),
        "kd": model.joint_target_kd.numpy().tolist(),
        "effort": model.joint_effort_limit.numpy().tolist(),
        "lower": model.joint_limit_lower.numpy().tolist(),
        "upper": model.joint_limit_upper.numpy().tolist(),
        "vel_limit": model.joint_velocity_limit.numpy().tolist(),
        "friction": model.joint_friction.numpy().tolist(),
        "friction_load_coefficient": getattr(getattr(model, "steel", None), "joint_friction_load_coefficient", None).numpy().tolist()
        if getattr(getattr(model, "steel", None), "joint_friction_load_coefficient", None) is not None
        else [],
        "spring_stiffness": model.joint_spring_stiffness.numpy().tolist() if getattr(model, "joint_spring_stiffness", None) is not None else [],
        "spring_ref": model.joint_spring_ref.numpy().tolist() if getattr(model, "joint_spring_ref", None) is not None else [],
        "passive_damping": model.joint_damping.numpy().tolist() if model.joint_damping is not None else [],
        "target_q": model.joint_target_q.numpy().tolist(),
        "target_qd": model.joint_target_qd.numpy().tolist(),
        "target_mode": model.joint_target_mode.numpy().tolist() if hasattr(model, "joint_target_mode") else [],
        "damping": model.joint_target_kd.numpy().tolist(),
        "articulation_start": model.articulation_start.numpy().tolist(),
        "label": list(model.joint_label),
    }
    flags = model.shape_flags.numpy()
    stype = model.shape_type.numpy()
    sbody = model.shape_body.numpy()
    sxf = model.shape_transform.numpy()
    mu = model.shape_material_mu.numpy()
    restitution = model.shape_material_restitution.numpy()
    mu_torsional = model.shape_material_mu_torsional.numpy()
    mu_rolling = model.shape_material_mu_rolling.numpy()
    shape_ke = model.shape_material_ke.numpy()
    shape_kd = model.shape_material_kd.numpy()
    gap = model.shape_gap.numpy() if hasattr(model, "shape_gap") else np.full(model.shape_count, 0.001)
    groups = model.shape_collision_group.numpy()
    worlds = model.shape_world.numpy()
    steel = getattr(model, "steel", None)
    condim = getattr(steel, "condim", None) if steel is not None else None
    condim = condim.numpy() if condim is not None else np.full(model.shape_count, 3)
    torsion_radius = getattr(steel, "min_torsional_patch_radius", None) if steel is not None else None
    torsion_radius = torsion_radius.numpy() if torsion_radius is not None else np.zeros(model.shape_count)
    colors = model.shape_color.numpy() if hasattr(model, "shape_color") else np.full((model.shape_count, 3), 0.7)
    hull_cache = {}
    shapes = []
    visuals = []
    textures = []
    for s in range(model.shape_count):
        collide = bool(flags[s] & int(newton.ShapeFlags.COLLIDE_SHAPES))
        t = int(stype[s])
        entry = {"sid": s, "body": int(sbody[s]), "xf": sxf[s].tolist(), "type": t, "color": colors[s].tolist()}
        material = {
            "mu": float(mu[s]),
            "gap": float(gap[s]),
            "restitution": float(restitution[s]),
            "mu_torsional": float(mu_torsional[s]),
            "mu_rolling": float(mu_rolling[s]),
            "group": int(groups[s]),
            "condim": int(condim[s]),
            "ke": float(shape_ke[s]),
            "kd": float(shape_kd[s]),
            "torsion_radius": float(torsion_radius[s]),
            "world": int(worlds[s]),
        }
        if t == G.PLANE:
            entry.update(plane=True, **material)
            shapes.append(entry)
            continue
        if collide:
            key = (t, tuple(np.round(model.shape_scale.numpy()[s], 9)), id(model.shape_source[s]) if model.shape_source[s] is not None else 0)
            if key not in hull_cache:
                verts, faces = hull_of(shape_points(model, s))
                fv, fstart, fn = [], [], []
                for f in faces:
                    fstart.append(len(fv))
                    fv.extend(f["v"])
                    fn.extend(f["n"] + [f["d"]])
                hull_cache[key] = {
                    "verts": put(verts, np.float32),
                    "face_planes": put(fn, np.float32),
                    "face_start": put(fstart + [len(fv)], np.uint32),
                    "face_verts": put(fv, np.uint32),
                    "nv": len(verts),
                    "nf": len(faces),
                }
            entry.update(hull=hull_cache[key], visible=bool(flags[s] & int(newton.ShapeFlags.VISIBLE)), **material)
            scale = model.shape_scale.numpy()[s]
            if t == G.SPHERE:
                entry["prim"] = {"kind": 1, "r": float(scale[0]), "h": 0.0}
            elif t == G.CAPSULE:
                entry["prim"] = {"kind": 2, "r": float(scale[0]), "h": float(scale[1])}
            shapes.append(entry)
        elif flags[s] & int(newton.ShapeFlags.VISIBLE):
            src = model.shape_source[s]
            scale = np.asarray(model.shape_scale.numpy()[s])
            entry = {"body": int(sbody[s]), "xf": sxf[s].tolist(), "color": colors[s].tolist()}
            if t in (G.BOX, G.SPHERE, G.CAPSULE, G.CYLINDER):
                # Visual-only primitives draw as flat-shaded hulls.
                key = ("vprim", t, tuple(np.round(scale, 9)))
                if key not in hull_cache:
                    verts, faces = hull_of(shape_points(model, s))
                    hull_cache[key] = {"verts": put(verts, np.float32), "face_start": put([0] + list(np.cumsum([len(f["v"]) for f in faces])), np.uint32),
                                       "face_verts": put([i for f in faces for i in f["v"]], np.uint32), "nv": len(verts), "nf": len(faces)}
                visuals.append({**entry, "hull": hull_cache[key]})
                continue
            if src is None or t not in (G.MESH, G.CONVEX_MESH):
                continue
            mkey = ("vis", id(src), tuple(np.round(scale, 9)))
            if mkey not in hull_cache:
                v = np.asarray(src.vertices, dtype=np.float32) * scale
                hull_cache[mkey] = {"v": put(v, np.float32), "i": put(np.asarray(src.indices, dtype=np.uint32), np.uint32)}
                tex = getattr(src, "texture", None)
                uvs = getattr(src, "uvs", None)
                if tex is not None and uvs is not None and len(uvs) == len(v):
                    from PIL import Image

                    tex_name = f"tex{len(textures)}.png"
                    image = Image.open(tex) if isinstance(tex, str) else Image.fromarray(
                        np.asarray(tex if np.asarray(tex).dtype == np.uint8 else np.clip(np.asarray(tex) * 255, 0, 255), dtype=np.uint8))
                    image.convert("RGBA" if image.mode in ("RGBA", "LA", "P") else "RGB").save(out / tex_name, optimize=True)
                    textures.append(tex_name)
                    hull_cache[mkey].update(uv=put(np.asarray(uvs, dtype=np.float32), np.float32), texture=tex_name)
            visuals.append({**entry, "mesh": hull_cache[mkey]})
    index = {e["sid"]: i for i, e in enumerate(shapes)}
    filters = sorted(
        {tuple(sorted((index[a], index[c]))) for a, c in model.shape_collision_filter_pairs if a in index and c in index}
    )
    scene = {
        "gravity": [0.0, 0.0, -9.81],
        "fps": 60,
        "substeps": solver["substeps"],
        "iterations": solver["iterations"],
        "bodies": bodies,
        "joints": joints,
        "shapes": shapes,
        "visuals": visuals,
        "filters": [list(p) for p in filters],
        "mimics": [
            {"follower": int(f), "leader": int(r), "c0": float(c0), "c1": float(c1), "enabled": bool(e)}
            for f, r, c0, c1, e in zip(
                *(getattr(model, f"constraint_mimic_{k}").numpy() for k in ("joint0", "joint1", "coef0", "coef1", "enabled"))
            )
        ]
        if getattr(model, "constraint_mimic_count", 0)
        else [],
        "targets": put(targets.astype(np.float32), np.float32),
        "target_frames": targets.shape[0],
        "driven": driven,
        "integral_count": int(integral_count),
        "demo": name,
        "control": control,
        "solver": solver,
        "info": json.loads(json.dumps(info, default=lambda o: np.asarray(o).tolist())),
        "joint_type_names": {m.name: int(m.value) for m in newton.JointType},
        "geo_type_names": {m.name: int(m.value) for m in newton.GeoType},
    }
    (out / "scene.json").write_text(json.dumps(scene))
    (out / "scene.bin").write_bytes(bytes(blob))
    share_assets(out)
    print(
        f"bodies {model.body_count} joints {model.joint_count} shapes {model.shape_count} "
        f"collide {sum(1 for s in shapes if 'hull' in s)} hulls {sum(1 for k in hull_cache if k[0] not in ('vis', 'vprim'))} "
        f"visuals {len(visuals)} bin {len(blob) / 1e6:.1f} MB filters {len(filters)}"
    )


def _mesh_budget(verts):
    """Triangle budget for a visual mesh: up to 15k, fewer for small parts (by bounding-box diagonal)."""
    diag = float(np.linalg.norm(verts.max(axis=0) - verts.min(axis=0))) if len(verts) else 0.0
    return int(max(5000, min(15000, 60000 * diag * diag)))


def _weld(verts, tris):
    """Merge coincident vertices (meshes often store each triangle's corners separately) and drop degenerates."""
    key = np.round(verts / 1e-6).astype(np.int64)
    _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    tris = inverse.reshape(-1)[tris]
    tris = tris[(tris[:, 0] != tris[:, 1]) & (tris[:, 1] != tris[:, 2]) & (tris[:, 0] != tris[:, 2])]
    return verts[first], tris


def _crease_split(verts, tris, degrees=30.0):
    """Give each vertex one copy per cluster of its faces within ``degrees`` of each other, so normals the viewer
    averages over shared vertices stay smooth across curvature and break at hard edges (CAD meshes mix both)."""
    e1, e2 = verts[tris[:, 1]] - verts[tris[:, 0]], verts[tris[:, 2]] - verts[tris[:, 0]]
    normals = np.cross(e1, e2)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-30)
    corners = tris.reshape(-1)
    faces = np.repeat(np.arange(len(tris)), 3)
    order = np.argsort(corners, kind="stable")
    starts = np.flatnonzero(np.r_[True, corners[order][1:] != corners[order][:-1], True])
    remap = np.empty(len(corners), np.int64)
    out, cos = [], math.cos(math.radians(degrees))
    for a, b in zip(starts[:-1], starts[1:], strict=True):
        seeds = []
        for c in order[a:b]:
            n = normals[faces[c]]
            hit = next((i for s, i in seeds if float(np.dot(s, n)) > cos), None)
            if hit is None:
                hit = len(out)
                out.append(verts[corners[c]])
                seeds.append((n, hit))
            remap[c] = hit
    return np.asarray(out, verts.dtype), remap.reshape(-1, 3)


def share_assets(out, shared=None):
    """Move a scene's visual meshes and textures into the content-addressed store ``<assets>/shared``.

    Identical meshes and textures across scenes (robot links, table textures) are then stored once.
    Untextured meshes over their triangle budget are decimated; indices use 16 bits when they fit.
    A mesh becomes ``{"file", "nv", "ni", "index", "uv"}``: positions (f32), indices, then UVs (f32),
    each section padded to 4 bytes. Collision and physics data stay in ``scene.bin``.
    """
    import hashlib

    out = Path(out)
    shared = Path(shared) if shared else out.parent / "shared"
    (shared / "meshes").mkdir(parents=True, exist_ok=True)
    (shared / "textures").mkdir(parents=True, exist_ok=True)
    scene = json.loads((out / "scene.json").read_text())
    blob = (out / "scene.bin").read_bytes()

    def view(ref, dtype):
        return np.frombuffer(blob, dtype=dtype, count=ref["n"], offset=ref["off"])

    def store(folder, data, suffix):
        name = hashlib.sha1(data).hexdigest()[:20] + suffix
        path = shared / folder / name
        if not path.exists():
            path.write_bytes(data)
        return f"../shared/{folder}/{name}"

    def pad4(b):
        return b + bytes(-len(b) % 4)

    meshes = {}
    for v in scene["visuals"]:
        m = v.get("mesh")
        if not m or "file" in m:
            continue
        key = m["v"]["off"]
        if key not in meshes:
            verts = view(m["v"], np.float32).reshape(-1, 3)
            tris = view(m["i"], np.uint32).reshape(-1, 3)
            uv = view(m["uv"], np.float32).reshape(-1, 2) if "uv" in m else None
            budget = _mesh_budget(verts)
            crease = False
            # Only meshes far over budget are simplified, on welded vertices so no holes open up;
            # the viewer then recomputes creased normals for them.
            if uv is None and len(tris) > 2 * budget:
                try:
                    import fast_simplification

                    wv, wt = _weld(verts.astype(np.float64), tris.astype(np.int64))
                    wv, wt = fast_simplification.simplify(wv, wt, target_reduction=1.0 - budget / len(wt))
                    verts, tris, crease = wv.astype(np.float32), wt.astype(np.uint32), True
                except ImportError:
                    pass
            if uv is None and not crease:
                verts, tris = _crease_split(*_weld(verts.astype(np.float64), tris.astype(np.int64)))
            u16 = len(verts) < 65536
            data = pad4(verts.astype(np.float32).tobytes()) + pad4(tris.astype(np.uint16 if u16 else np.uint32).tobytes())
            if uv is not None:
                data += uv.astype(np.float32).tobytes()
            entry = {"file": store("meshes", data, ".bin"), "nv": len(verts), "ni": int(tris.size), "index": "u16" if u16 else "u32", "uv": uv is not None}
            if crease:
                entry["crease"] = True
            if "texture" in m:
                tex = out / m["texture"]
                entry["texture"] = store("textures", tex.read_bytes(), ".png") if tex.exists() else m["texture"]
            meshes[key] = entry
        v["mesh"] = meshes[key]
    for tex in out.glob("tex*.png"):
        tex.unlink()

    # Repack scene.bin with the references that remain (all 4-byte elements); shared blocks stay shared.
    packed = bytearray()
    moved = {}

    def repack(node):
        if isinstance(node, dict):
            if "off" in node and "n" in node and len(node) == 2:
                key = (node["off"], node["n"])
                if key not in moved:
                    moved[key] = len(packed)
                    packed.extend(blob[node["off"] : node["off"] + node["n"] * 4])
                node["off"] = moved[key]
                return
            for value in node.values():
                repack(value)
        elif isinstance(node, list):
            for value in node:
                repack(value)

    repack(scene)
    (out / "scene.json").write_text(json.dumps(scene))
    (out / "scene.bin").write_bytes(bytes(packed))


if __name__ == "__main__":
    import sys

    # Migrate already exported scenes: python newton_export.py <scene dir>...
    for folder in sys.argv[1:]:
        share_assets(folder)
        print(folder, f"scene.bin {(Path(folder) / 'scene.bin').stat().st_size / 1e6:.2f} MB")
