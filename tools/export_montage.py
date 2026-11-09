# SPDX-License-Identifier: Apache-2.0
"""Export hero-montage stations (``scripts/benchmarks/hero_montage``) for the WebGPU port.

    uv run --with scipy python <this file> <hero_montage dir> <assets.json> <station> <out_dir> [targets.npz]

``<station>`` is ``<kind>-<variant>`` as in the rosters; ``assets.json`` is the output of the
montage's ``prepare_assets.py``. ``targets.npz`` replays a recorded ``joint-targets.npz`` instead
of planning IK (as ``HERO_REPLAY_JOINT_TARGETS``). Only open-loop stations export; policy-driven
ones (``hand``, ``g1``, ``go2``) and closed-loop servos are refused.
"""

import json
import sys
from itertools import pairwise
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from newton_export import export_model  # noqa: E402

# Seconds, from the montage README and runners.
DURATION = {"beer_pong": 7, "spinning_top": 9, "box_turn": 13, "cereal": 18, "toaster": 18, "lava_fall": 6}
# Steel settings per kind (substeps, iterations), sized for 20 ms frames in the browser.
SOLVER = {"cereal": (3, 8), "spill": (3, 10), "drawer": (4, 8), "lift": (4, 8), "stack": (2, 16)}
# Grasped thin objects: the montage's point friction, with Steel's warm start so the pads'
# twist friction converges within the iteration budget.
SOLVER_OPTIONS = {k: {"contact_warmstart": True, "friction_anchor_beta": 0.0} for k in ("toaster", "cereal")}
# The toaster's slice is held by a pinch: finger-pad contact torsion (1 cm patch radius) with friction
# anchors keeps it from pivoting low in the grasp and pressing the carriage down on insertion.
SOLVER_OPTIONS["toaster"]["friction_anchor_beta"] = 0.2
PAD_TORSION_RADIUS = {"toaster": 0.01}
# Bodies laid out in a lattice that a low-iteration solve cannot hold (cereal letters 21 layers deep
# nest into each other and pop out); they start from the pile they settle into.
SETTLE = {"cereal": ("cereal_pieces", "tracked_body")}
# The montage's own runner keeps friction anchors off for the lava pile; regularization calms the settled pile.
SOLVER_OPTIONS["lava_fall"] = {"friction_anchor_beta": 0.0, "contact_regularization": 0.01}
# Warm start where it lets the task pass in half the sweeps.
for k in ("drawer", "lift", "stack"):
    SOLVER_OPTIONS[k] = {"contact_warmstart": True}
# The jenga tower rocks at rest without regularization; 0.005 brings it to rest at 2x16, cheaper than 4x8.
SOLVER_OPTIONS["stack"]["contact_regularization"] = 0.005
# Sleeping where the scene comes to rest and it was validated: faster, and the task still passes.
for k in ("toaster", "kit", "drawer", "stack", "lift", "sort"):
    SOLVER_OPTIONS.setdefault(k, {})["enable_sleeping"] = True
# Standalone runners: they ignore phase_delay and interpolate targets at every substep.
NO_PHASE_DELAY = ("toaster", "cereal")


def interpolate(waypoints, t, smooth=True):
    """``run.interpolate``: quintic smoothstep between waypoints unless dense."""
    if t <= waypoints[0][0]:
        return waypoints[0][1]
    for (ta, a), (tb, b) in pairwise(waypoints):
        if t <= tb:
            u = (t - ta) / (tb - ta)
            if smooth:
                u = u * u * u * (10 + u * (-15 + 6 * u))
            return a + (b - a) * u
    return waypoints[-1][1]


def settle(b, bodies, container, phases=((240, 1.5), (960, 0.25))):
    """Rest free bodies where they land in a container held still (Newton Steel on the CPU, high budget);
    the short fine-step phase relaxes the overlaps the coarse one leaves under the pile's weight."""
    import warp as wp  # noqa: PLC0415

    import newton  # noqa: PLC0415

    model = b.finalize(device="cpu")
    state = model.state()
    newton.eval_fk(model, model.joint_q, model.joint_qd, state)
    pose = state.body_q.numpy()
    xf, scale, kind = model.shape_transform.numpy(), model.shape_scale.numpy(), model.shape_type.numpy()
    owner, flags = model.shape_body.numpy(), model.shape_flags.numpy()
    mu, gap, rest = model.shape_material_mu.numpy(), model.shape_gap.numpy(), model.shape_material_restitution.numpy()
    G, collide = newton.GeoType, int(newton.ShapeFlags.COLLIDE_SHAPES)
    s = newton.ModelBuilder()
    index = {}
    for body in bodies:
        index[body] = s.add_body(xform=wp.transform(wp.vec3(*pose[body][:3]), wp.quat(*pose[body][3:])), mass=b.body_mass[body],
                                 com=b.body_com[body], inertia=b.body_inertia[body], lock_inertia=True)
    holder = wp.transform(wp.vec3(*pose[container][:3]), wp.quat(*pose[container][3:]))
    for i in np.flatnonzero((flags & collide) != 0):
        if owner[i] not in index and owner[i] != container:
            continue
        cfg = newton.ModelBuilder.ShapeConfig(density=0.0, mu=float(mu[i]), gap=float(gap[i]), restitution=float(rest[i]))
        t = wp.transform(wp.vec3(*xf[i][:3]), wp.quat(*xf[i][3:]))
        if owner[i] in index and kind[i] == G.CAPSULE:
            s.add_shape_capsule(index[owner[i]], xform=t, radius=float(scale[i][0]), half_height=float(scale[i][1]), cfg=cfg)
        elif owner[i] == container and kind[i] == G.BOX:
            s.add_shape_box(-1, xform=holder * t, hx=float(scale[i][0]), hy=float(scale[i][1]), hz=float(scale[i][2]), cfg=cfg)
        else:
            raise ValueError(f"settle supports capsule bodies in a box container, not shape type {kind[i]}")
    m = s.finalize(device="cpu")
    s0, s1, control = m.state(), m.state(), m.control()
    newton.eval_fk(m, m.joint_q, m.joint_qd, s0)
    pipeline = newton.CollisionPipeline(m)
    contacts = pipeline.contacts()
    solver = newton.solvers.SolverSteel(m, solve_mode="split", iterations=32, free_body_constraint_max=8192)
    for hz, seconds in phases:
        for _ in range(round(seconds * hz)):
            s0.clear_forces()
            pipeline.collide(s0, contacts)
            solver.step(s0, s1, control, contacts, 1.0 / hz)
            s0, s1 = s1, s0
    q = s0.body_q.numpy()
    joints = {child: j for j, child in enumerate(b.joint_child)}
    for body, k in index.items():
        qs = b.joint_q_start[joints[body]]
        b.joint_q[qs : qs + 7] = q[k].tolist()


def main(montage, assets_path, station, out, replay=None):
    sys.path.insert(0, str(Path(montage).resolve()))
    import scene
    from scene import build_template

    if replay:
        # Hold the start pose; the recorded targets replace the plan.
        scene.plan_ik = lambda b, ee, offset, poses, device, **_: [
            (p[0], np.asarray(b.joint_q[: getattr(b, "_hero_driven_dofs", 9)], dtype=np.float64)) for p in poses
        ]
    kind, variant = station.rsplit("-", 1)
    b, info = build_template(kind, int(variant), json.loads(Path(assets_path).read_text()), "cpu")
    if info.get("policy") or "hora_policy" in info or "_servo_model" in info or "_thumb_ik_model" in info:
        sys.exit(f"{station} needs a policy or closed-loop servo; not exportable")
    if replay:
        # plan_ik starts the robots at the first planned pose.
        recorded = np.load(replay)["targets"]
        n = len(info["waypoints"][0][1])
        b.joint_q[:n] = recorded[0, :n].tolist()
        b.joint_target_q[:n] = recorded[0, :n].tolist()
    if kind == "lava_fall":
        # The montage's packing leaves pieces on the table; start from a pile settled in the port (figure away).
        joints = {child: j for j, child in enumerate(b.joint_child)}
        pile = json.loads((Path(__file__).parent / "lava_fall_pile.json").read_text())
        for body, pose in zip(info["lava_bodies"], pile, strict=True):
            qs = b.joint_q_start[joints[body]]
            b.joint_q[qs : qs + 7] = pose
        # Slippery flames and figure (0.01; montage 0.025, 0.12) so the figure sinks; pot at 0.15 (montage 0.04).
        for si, label in enumerate(b.shape_label):
            if label.startswith("pot/"):
                b.shape_material_mu[si] = 0.15
            elif label.startswith(("lava/", "mini_g1/")):
                b.shape_material_mu[si] = 0.01
    b.add_ground_plane(height=-0.80, color=(0.78, 0.79, 0.78))
    if kind in SETTLE:
        settle(b, info[SETTLE[kind][0]], info[SETTLE[kind][1]])
    model = b.finalize(device="cpu")
    duration = max(DURATION.get(kind, 14), info.get("motion_duration", 0) + 0.5)
    times = np.arange(round(duration * 60) + 1) / 60
    if replay:
        data = np.load(replay)
        recorded, fps = data["targets"], float(data["fps"])
        driven = len(info["waypoints"][0][1])
        t = np.arange(len(recorded)) / fps
        targets = np.stack([np.interp(times, t, recorded[:, i]) for i in range(driven)], axis=1)
    elif info["waypoints"]:
        waypoints = [(t, np.asarray(v, dtype=np.float64)) for t, v in info["waypoints"]]
        extra = info.get("extra_drives", [])
        driven = max([len(waypoints[0][1])] + [i + 1 for i, _ in extra])
        delay = 0 if kind in NO_PHASE_DELAY else info.get("phase_delay", int(variant) * 0.25)
        smooth = not info.get("dense_waypoints", False)
        targets = np.tile(np.asarray(b.joint_target_q[:driven], dtype=np.float64), (len(times), 1))
        for f, t in enumerate(times):
            u = max(0.0, t - delay)
            targets[f, : len(waypoints[0][1])] = interpolate(waypoints, u, smooth)
            for i, points in extra:
                targets[f, i] = interpolate(points, u)
    else:
        targets, driven = None, 0
    meta = {k: v for k, v in info.items() if k not in ("waypoints", "policy", "furnishings") and not k.startswith("_")}
    export_model(
        model,
        out,
        name=Path(out).name,
        solver={"substeps": SOLVER.get(kind, (4, 16))[0], "iterations": SOLVER.get(kind, (4, 16))[1], "enable_joint_velocity_limits": True,
                **SOLVER_OPTIONS.get(kind, {})},
        targets=targets,
        driven=driven,
        integral_count=int(info.get("integral_drive_count", 0)),
        targets_per_substep=kind in NO_PHASE_DELAY,
        info=meta,
    )
    radius = PAD_TORSION_RADIUS.get(kind)
    if radius:
        path = Path(out) / "scene.json"
        scene = json.loads(path.read_text())
        labels = scene["bodies"]["label"]
        for shape in scene["shapes"]:
            if shape["body"] >= 0 and "finger" in labels[shape["body"]]:
                shape["torsion_radius"] = radius
        path.write_text(json.dumps(scene))


if __name__ == "__main__":
    main(*sys.argv[1:6])
