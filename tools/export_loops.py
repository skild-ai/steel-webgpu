# SPDX-License-Identifier: Apache-2.0
"""Closed-loop linkage scenes from newton-shelf's looped-linkage examples, exported for the WebGPU port.

Run from a newton-shelf checkout (its ``common`` and ``shelf`` packages build the mechanisms):
    python <this file> <scene|all> <assets/scenes dir>

Each mechanism is one articulation (a spanning tree) whose remaining joints close the loops as loop rows (three
per ball, five per revolute). The actuated joints follow the example's scripted trajectory, baked into a 60 Hz
target table that the port interpolates per substep and replays from the end of the ramp. Solver settings start
from newton-shelf's tuned Steel presets (taken at 50 fps there, 60 fps here).
"""

import importlib.util
import json
import math
import os
import sys
import types
from pathlib import Path

import numpy as np

import newton

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, os.getcwd())
from newton_export import export_model  # noqa: E402

FPS = 60


def shelf_module(path):
    """An example module of the newton-shelf checkout in the working directory."""
    spec = importlib.util.spec_from_file_location(Path(path).parent.name, Path(os.getcwd()) / path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sample_times(frames, substeps):
    """Table times: a row per 60 Hz frame, sampled so each substep reads its target for the end of that substep.

    newton-shelf writes each substep's target for the end of that substep. The port reads row ``r`` at the
    substep whose midpoint is ``(r + 0.5) / 60``, so row ``r`` holds the target half a frame and half a
    substep later.
    """
    return (np.arange(frames) + 0.5) / FPS + 0.5 / (FPS * substeps)


def p33(mechanism, period, substeps):
    """A P33 mechanism (common/loop_mechanisms.py): its model, the targets of its actuated joints and their dofs."""
    from common.loop_linkage import build_model
    from common.loop_mechanisms import get_mechanism

    mech = get_mechanism(mechanism)
    model, jid = build_model(mech)
    # build_model takes the shapes' sizes but not their colors
    model.shape_color.assign(np.array([s.color for body in mech.bodies for s in body.shapes], dtype=np.float32))
    ramp = FPS  # every mechanism's drive ramps in over its first second
    rows = ramp + round(period * FPS) + 1  # the last row closes the period
    q, _ = mech.target_table(sample_times(rows, substeps))
    qd_start = model.joint_qd_start.numpy()
    dofs = [int(qd_start[jid[i]]) for i in mech.actuated]
    return model, dict(targets=q, driven_dofs=dofs, target_loop=ramp, target_velocity=True)


def hoberman(substeps):
    """The Hoberman sphere with one driven hub, lifted 0.3 m so it floats clear of the floor grid."""
    mod = shelf_module("shelf/05_looped_linkages/loop_hoberman_sphere/example.py")
    G, P = mod.Graph(mod.PARAMS), mod.PARAMS
    model, info = mod.build_model(G, "one")
    q = model.joint_q.numpy()
    q[2] += 0.3  # the free root's z
    model.joint_q.assign(q)
    q_start, qd_start = model.joint_q_start.numpy(), model.joint_qd_start.numpy()
    joints = [info["coord_joint"][j] for j in info["drive"]]
    closed = np.array([info["sign"][j] * G.joint_q_of_phi(j, math.radians(P.phi_max)) for j in info["drive"]])
    opened = np.array([info["sign"][j] * G.joint_q_of_phi(j, math.radians(P.phi_min)) for j in info["drive"]])
    rows = round(P.period * FPS) + 1
    s = 0.5 - 0.5 * np.cos(2.0 * np.pi * sample_times(rows, substeps) / P.period)
    assert all(q_start[j + 1] - q_start[j] == 1 for j in joints)
    return model, dict(targets=closed + s[:, None] * (opened - closed), driven_dofs=[int(qd_start[j]) for j in joints], target_loop=0)


def dr_legs(substeps):
    """The DR legs robot walking its 22.4 s clip (the example's --animated run), then standing on its last pose."""
    os.environ["SHELF_SOLVER"] = "steel_walk"
    path = "shelf/06_looped_linkages_contacts/loop_dr_legs/example.py"
    if not (Path(os.getcwd()) / path).exists():  # checkouts from before the scene renames
        path = "shelf/06_looped_linkages_contacts/kamino_robot_dr_legs/example.py"
    mod = shelf_module(path)
    args = types.SimpleNamespace(world_count=1, animated=True, closures="revolute", test=False, use_kamino_contacts=False, joint_effort_limit=None)
    ex = mod.Example(newton.viewer.ViewerNull(), args)
    model = ex.model
    clip = ex.animation_data.numpy()  # 100 Hz frames x channels, held per frame
    coords = ex.animation_indices.numpy()[0]
    q_start, qd_start = model.joint_q_start.numpy(), model.joint_qd_start.numpy()
    joint_of = {int(q_start[j]): j for j in range(model.joint_count)}
    dofs = [int(qd_start[joint_of[int(c)]]) for c in coords]
    t = sample_times(math.ceil(len(clip) * ex.animation_dt * FPS) + 1, substeps)
    rows = np.minimum(np.floor(t / ex.animation_dt).astype(int), len(clip) - 1)
    return model, dict(targets=clip[rows], driven_dofs=dofs)


# name: (build(substeps), solver, camera, title, about, short)
SCENES = {
    "loop_stewart_platform": (
        lambda n: p33("stewart", 10.0, n),
        {"substeps": 1, "iterations": 28},
        {"eye": (-0.44, 0.761, 0.66), "target": (0.0, 0.0, 0.25)},
        "Stewart platform",
        "A 6-UPS hexapod: six prismatic legs carry a 2 kg platform through heave, roll, pitch and yaw. Five spatial loops share the platform, closed by ball joints.",
        "Six driven legs tilt and lift a platform through five closed loops.",
    ),
    "loop_delta_robot": (
        lambda n: p33("delta", 10.0, n),
        {"substeps": 2, "iterations": 28},
        {"eye": (-0.248, -0.681, 0.814), "target": (0.0, 0.0, 0.62)},
        "Delta robot",
        "Three driven upper arms carry a platform through parallelogram forearms; the shoulders trace phase-shifted sines, so the platform circles while it rises and falls. Five loops, closed by ball joints.",
        "Three driven arms circle a delta robot's platform.",
    ),
    "loop_parallel_gripper": (
        lambda n: p33("gripper", 2.0, n),
        {"substeps": 2, "iterations": 48},
        {"eye": (-0.152, -0.416, 0.578), "target": (0.0, 0.0, 0.5)},
        "Parallel gripper",
        "A prismatic actuator swings two parallelogram fingers through connecting rods, so the jaws close and open every 2 s while staying vertical. Four loops, closed by revolute joints.",
        "One actuator closes two parallelogram jaws.",
    ),
    "loop_hoberman_sphere": (
        hoberman,
        {"substeps": 4, "iterations": 64},
        {"eye": (-0.42, -0.42, 0.42), "target": (0.0, 0.0, 0.3)},
        "Hoberman sphere",
        "A Hoberman sphere of 120 bars in zero gravity: one driven hub opens it from a scissor angle of 120 to 30 degrees and closes it again every 4 s. 91 revolute loop closures in one articulation.",
        "One driven hinge opens and closes a 120-bar sphere.",
    ),
    "dr_legs_walk": (
        dr_legs,
        {"substeps": 8, "iterations": 48, "enable_joint_limits": True, "joint_limit_activation_gap": 0.1},
        {"eye": (1.34, -0.6, 0.45), "target": (0.0, 0.0, 0.25)},
        "DR legs walk",
        "The DR legs biped walks a 22.4 s clip on its servos. Each leg has a four-bar in its chain and a spatial ankle loop, six revolute loop closures in all.",
        "A biped with closed-loop legs walks on its servos.",
    ),
}


def build(name, out_root):
    make, solver, camera, title, about, short = SCENES[name]
    model, drive = make(solver["substeps"])
    targets = np.asarray(drive.pop("targets"), dtype=np.float32)
    export_model(
        model, Path(out_root) / name, name=name, solver=solver, targets=targets, driven=targets.shape[1],
        info={"about": about, "camera": camera}, **drive,
    )
    return title, about, short


def main(which, out_root):
    names = list(SCENES) if which == "all" else which.split(",")
    index_path = Path(out_root) / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    for name in names:
        title, about, short = build(name, out_root)
        if not any(e["name"] == name for e in index):  # curated entries in index.json are kept
            index.append({"name": name, "title": title, "about": about, "category": "Mechanisms", "short": short})
    index_path.write_text(json.dumps(index, indent=1) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
