# SPDX-License-Identifier: Apache-2.0
"""Build a Newton Steel tabletop demo scene and export it for the WebGPU port.

Run from a Newton checkout that has the Steel tabletop examples:
    uv run --with scipy python <this file> <demo> <out_dir>
    uv run --with scipy python <this file> --survey
where <demo> is the suffix of ``example_steel_<demo>`` (bolt_sweep, cup_unpacking, ...).
"""

import importlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import warp as wp

import newton
import newton.examples
import newton.utils
from newton.examples.robot._tabletop_common import box
from newton.examples.robot._tabletop_robot import make_arm

sys.path.insert(0, str(Path(__file__).resolve().parent))
from newton_export import export_model  # noqa: E402



# Fewer substeps and sweeps where the example's own checks still pass in the browser. Warm-started
# contacts let the piles and the rope converge in fewer sweeps (and keep the rope still at rest).
# Regularization stops single bolts rocking in the settled bin.
SOLVER = {
    "bolt_sweep": {"iterations": 8, "contact_warmstart": True, "nesterov_momentum": True, "contact_regularization": 0.01},
    "cup_unpacking": {"iterations": 6, "contact_warmstart": True, "friction_anchor_beta": 0.2, "contact_regularization": 0.01, "enable_sleeping": True},
    "plate_rack": {"friction_anchor_beta": 0.2},
    "toy_well": {"substeps": 2, "iterations": 12, "contact_warmstart": True},
    "wrecking_ball": {"substeps": 3, "iterations": 12},
}


# Collision proxies reworked after export (tools/proxies.py): the washers' and nuts' rings of small
# boxes interlocked with each other and the bolts' 48-vertex round parts went to MPR, whose normal
# flickers between facets; one hull each, at most 16 vertices, takes the exact SAT.
PROXIES = {"bolt_sweep": [("merge", ["/washer/", "/hex_nut/"]), ("simplify", 16, ["/washer/", "/hex_nut/", "/hex_bolt/"])]}

# Pinch grasps hold against twist through Steel's contact torsion on the finger pads (about 1 cm
# patch radius) and friction anchors; without them the mug and the plate turn in the grasp.
PAD_TORSION_RADIUS = {"cup_unpacking": 0.01, "plate_rack": 0.01}


def build(demo):
    """Replicate ``TabletopDemo.__init__`` up to ``finalize`` for ``example_steel_<demo>``."""
    newton.use_coord_layout_targets = True
    cls = importlib.import_module(f"newton.examples.robot.example_steel_{demo}").Example
    ex = object.__new__(cls)
    task = cls.task
    b = newton.ModelBuilder()
    b.default_shape_cfg.mu = 0.75
    b.default_shape_cfg.gap = 0.001
    b.default_shape_cfg.restitution = 0.02
    b.default_shape_cfg.density = 600
    assets = {
        "franka_emika_panda": str(
            newton.utils.download_asset("franka_emika_panda", ref="f8fb7abcbeba2318814a74f3eeb02780ad7925d6")
        )
    }
    robot = "franka" if task == "plates" else "ur10"
    if robot == "ur10":
        assets["ur10_menagerie"] = str(
            newton.examples.download_external_git_folder(
                "https://github.com/google-deepmind/mujoco_menagerie.git",
                "universal_robots_ur10e",
                ref="f054586a8e90465d49ee5be15335c4a0c7f57caf",
            )
        )
    ee, down, fingers = make_arm(
        b,
        assets,
        wp.get_device(),
        robot=robot,
        root=cls.robot_root or ((-0.30, 0, 0) if robot == "franka" else (-0.42, 0, 0)),
        gripper=task != "sweep",
    )
    info = {}
    ex.populate(b, info, ee, down, fingers)
    driven = b._tabletop_driven_dofs
    waypoints = info.pop("waypoints")
    times = np.array([p[0] for p in waypoints])
    values = np.array([p[1] for p in waypoints])
    timeline = np.arange(901) / 60
    targets = np.column_stack([np.interp(timeline, times, values[:, i]) for i in range(driven)])
    box(b, (0.05, 0, -0.035), (0.95, 0.86, 0.035), (0.52, 0.61, 0.67), label="table")
    for x in (-0.72, 0.82):
        for y in (-0.68, 0.68):
            box(b, (x, y, -0.39), (0.025, 0.025, 0.32), (0.16, 0.20, 0.23), label="table_leg")
    b.add_ground_plane(height=-0.75)
    model = b.finalize(device="cpu")
    parser = cls.create_parser()
    defaults = parser.parse_args([])
    info["solver"] = {
        "substeps": defaults.substeps,
        "iterations": defaults.iterations,
        "contact_response": defaults.contact_response,
        "enable_joint_friction": task == "crane",
        "enable_joint_velocity_limits": True,
        "contact_regularization": 0.0,
        # Validated: same outcome, faster once the scene comes to rest.
        "enable_sleeping": task in ("crane", "plates"),
    }
    # Newton's examples turn friction anchors off; without their pull-back the crane task's
    # building creeps apart before the strike, so it keeps Steel's default.
    if task != "crane":
        info["solver"]["friction_anchor_beta"] = 0.0
    else:
        # Momentum keeps the stacked building still before the strike (1.8 -> 0.3 mm drift).
        info["solver"]["nesterov_momentum"] = True
    info["solver"].update(SOLVER.get(demo, {}))
    return b, model, info, targets, driven


def control_spec(demo, info):
    """Per-substep controllers of the demos (``update_control``), in Newton indices."""
    if demo == "pelican_bicycle":
        return {"type": "fader", "fader_q": int(info["pelican_fader_q"]), "wheel_v": int(info["pelican_wheel_v"]),
                "travel": 0.24, "max_speed": 2 * math.pi}
    return None


def main(demo, out):
    b, model, info, targets, driven = build(demo)
    solver = info.pop("solver")
    export_model(
        model,
        out,
        name=demo,
        solver=solver,
        targets=targets,
        driven=driven,
        integral_count=info.get("integral_drive_count", 0),
        control=control_spec(demo, info),
        info=info,
    )
    if demo in PROXIES:
        import proxies

        scene = proxies.Scene(out)
        for step in PROXIES[demo]:
            print(proxies.merge(scene, step[1]) if step[0] == "merge" else proxies.simplify(scene, step[1], step[2]))
        scene.save()
    radius = PAD_TORSION_RADIUS.get(demo)
    if radius:
        path = Path(out) / "scene.json"
        scene = json.loads(path.read_text())
        labels = scene["bodies"]["label"]
        for shape in scene["shapes"]:
            if shape["body"] >= 0 and "finger" in labels[shape["body"]]:
                shape["torsion_radius"] = radius
        path.write_text(json.dumps(scene))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
