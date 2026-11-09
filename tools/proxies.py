# SPDX-License-Identifier: Apache-2.0
"""Rework the convex collision proxies of an exported scene.

    uv run --with scipy python <this file> <scene dir> merge <body label substring>...
    uv run --with scipy python <this file> <scene dir> simplify <max vertices> <body label substring>...

``merge`` turns each matching body's convex parts into one hull: a ring decomposed into small parts
(a washer, a nut) can interlock with another ring and stay interpenetrated; one hull of the same
outline cannot, and it makes far fewer contacts. ``simplify`` reduces hulls above the vertex budget
by dropping, one at a time, the vertex whose removal loses the least volume; hulls of at most 16
vertices take the narrowphase's exact SAT instead of MPR, whose normal flickers between the facets
of finely tessellated round parts.
"""

import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import ConvexHull

sys.path.insert(0, str(Path(__file__).resolve().parent))
from newton_export import hull_of  # noqa: E402


def quat_rotate(q, v):
    x, y, z, w = q
    t = 2 * np.cross([x, y, z], v)
    return v + w * t + np.cross([x, y, z], t)


def reduce_hull(points, max_verts):
    """Greedy volume-preserving vertex removal; returns the kept points and the largest distance of a
    dropped point outside the reduced hull."""
    pts = np.asarray(points, dtype=np.float64)
    pts = pts[ConvexHull(pts).vertices]
    while len(pts) > max_verts:
        best, best_vol = None, -1.0
        for i in range(len(pts)):
            vol = ConvexHull(np.delete(pts, i, axis=0)).volume
            if vol > best_vol:
                best, best_vol = i, vol
        pts = np.delete(pts, best, axis=0)
        pts = pts[ConvexHull(pts).vertices]
    hull = ConvexHull(pts)
    dev = float(np.max(np.asarray(points) @ hull.equations[:, :3].T + hull.equations[:, 3], initial=0.0))
    return pts, dev


class Scene:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.json = json.loads((self.folder / "scene.json").read_text())
        self.blob = bytearray((self.folder / "scene.bin").read_bytes())
        self.cache = {}

    def view(self, ref, dtype):
        return np.frombuffer(bytes(self.blob), dtype, ref["n"], ref["off"])

    def put(self, arr, dtype):
        a = np.ascontiguousarray(np.asarray(arr, dtype=dtype).ravel())
        ref = {"off": len(self.blob), "n": int(a.size)}
        self.blob.extend(a.tobytes())
        return ref

    def hull(self, points):
        key = tuple(np.round(np.asarray(points), 6).ravel())
        if key not in self.cache:
            verts, faces = hull_of(points)
            fv, fstart, fn = [], [], []
            for f in faces:
                fstart.append(len(fv))
                fv.extend(f["v"])
                fn.extend(f["n"] + [f["d"]])
            self.cache[key] = {"verts": self.put(verts, np.float32), "face_planes": self.put(fn, np.float32),
                               "face_start": self.put(fstart + [len(fv)], np.uint32),
                               "face_verts": self.put(fv, np.uint32), "nv": len(verts), "nf": len(faces)}
        return self.cache[key]

    def bodies(self, patterns):
        labels = self.json["bodies"]["label"]
        return {b for b, label in enumerate(labels) if any(p in label for p in patterns)}

    def save(self):
        # Repack scene.bin with only the blocks still referenced.
        packed, moved, seen = bytearray(), {}, set()

        def repack(node):
            if isinstance(node, dict):
                if set(node) == {"off", "n"}:
                    # Hulls made here are shared by several shapes: move each reference once.
                    if id(node) in seen:
                        return
                    seen.add(id(node))
                    key = (node["off"], node["n"])
                    if key not in moved:
                        moved[key] = len(packed)
                        packed.extend(self.blob[node["off"] : node["off"] + node["n"] * 4])
                    node["off"] = moved[key]
                    return
                for value in node.values():
                    repack(value)
            elif isinstance(node, list):
                for value in node:
                    repack(value)

        repack(self.json)
        (self.folder / "scene.json").write_text(json.dumps(self.json))
        (self.folder / "scene.bin").write_bytes(bytes(packed))


def merge(scene, patterns):
    bodies = scene.bodies(patterns)
    merged, remap, shapes = {}, {}, []
    for i, s in enumerate(scene.json["shapes"]):
        b = s["body"]
        if b not in bodies or "hull" not in s or s.get("prim"):
            remap[i] = len(shapes)
            shapes.append(s)
            continue
        verts = scene.view(s["hull"]["verts"], np.float32).reshape(-1, 3)
        xf = s["xf"]
        if b not in merged:
            merged[b] = {"points": [], "first": s, "index": len(shapes)}
            shapes.append(None)
        merged[b]["points"].extend(np.asarray(xf[:3]) + quat_rotate(xf[3:], v) for v in verts)
        remap[i] = merged[b]["index"]
    for m in merged.values():
        shapes[m["index"]] = {**m["first"], "xf": [0, 0, 0, 0, 0, 0, 1], "hull": scene.hull(m["points"])}
    scene.json["shapes"] = shapes
    filters = {tuple(sorted((remap[a], remap[c]))) for a, c in scene.json["filters"] if remap[a] != remap[c]}
    scene.json["filters"] = [list(p) for p in sorted(filters)]
    return f"merged {len(merged)} bodies"


def simplify(scene, max_verts, patterns):
    bodies = scene.bodies(patterns)
    done, worst = {}, 0.0
    for s in scene.json["shapes"]:
        if s["body"] not in bodies or "hull" not in s or s.get("prim") or s["hull"]["nv"] <= max_verts:
            continue
        ref = s["hull"]["verts"]["off"]
        if ref not in done:
            pts, dev = reduce_hull(scene.view(s["hull"]["verts"], np.float32).reshape(-1, 3), max_verts)
            done[ref] = scene.hull(pts)
            worst = max(worst, dev)
        s["hull"] = done[ref]
    return f"simplified {len(done)} hulls to <= {max_verts} vertices; largest deviation {worst * 1000:.2f} mm"


if __name__ == "__main__":
    scene = Scene(sys.argv[1])
    if sys.argv[2] == "merge":
        print(merge(scene, sys.argv[3:]))
    else:
        print(simplify(scene, int(sys.argv[3]), sys.argv[4:]))
    scene.save()
