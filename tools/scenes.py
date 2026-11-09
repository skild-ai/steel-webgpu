# SPDX-License-Identifier: Apache-2.0
"""Feature scenes for the WebGPU Steel port, built as Newton models and exported.

    uv run --with scipy python <this file> <scene|all> <assets/scenes dir>

Each scene shows one solver feature side by side with its absence.
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
import warp as wp

import newton

sys.path.insert(0, str(Path(__file__).resolve().parent))
from newton_export import export_model  # noqa: E402

BLUE, TEAL, GOLD, RED, GREY = (0.06, 0.38, 0.70), (0.06, 0.57, 0.43), (0.92, 0.66, 0.20), (0.80, 0.25, 0.20), (0.45, 0.5, 0.55)


def tf(p=(0, 0, 0), q=None):
    return wp.transform(wp.vec3(*p), wp.quat_identity() if q is None else q)


# Contact gap for every shape: wide enough for the fastest bodies here to be caught by a speculative contact
# within a substep, not Newton's 0.1 m default, which keeps contacts alive between bodies a hand-width apart.
GAP = 0.01


def builder():
    b = newton.ModelBuilder()
    b.default_shape_cfg.gap = GAP
    return b


def cfg(**kw):
    c = newton.ModelBuilder.ShapeConfig(gap=GAP)
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def dominoes():
    """Ground plane: a 480-piece spiral of dominoes toppling in a chain, winding in to the center."""
    b = builder()
    # Newton's default 0.1 m gap is a whole domino height: every piece would hold speculative contacts
    # with pieces several spacings away and with the next ring, past the solver's body-pair capacity.
    b.default_shape_cfg.gap = 0.02
    b.add_ground_plane()
    twists = {}
    # Archimedean spiral r = r0 + k * theta, walked inward from the outer end at an even arc spacing.
    count, spacing, pitch, r0 = 480, 0.07, 0.15, 0.35
    k = pitch / (2.0 * math.pi)
    # Arc length from theta = 0 is r0 * theta + k * theta^2 / 2 (r >> k).
    theta = (math.sqrt(r0 * r0 + 2.0 * k * count * spacing) - r0) / k
    for i in range(count):
        r = r0 + k * theta
        p = (r * math.cos(theta), r * math.sin(theta), 0.05)
        # Walking toward smaller theta: the tangent is -d(r cos, r sin)/dtheta.
        dx = -(k * math.cos(theta) - r * math.sin(theta))
        dy = -(k * math.sin(theta) + r * math.cos(theta))
        q = wp.quat_rpy(0.0, 0.0, math.atan2(dy, dx))
        if i == 0:
            # Lean the first piece 25 deg onto the next, pivoting on its bottom edge.
            edge = wp.vec3(0.005, 0.0, -0.05)
            tilted = q * wp.quat_from_axis_angle(wp.vec3(0.0, 1.0, 0.0), math.radians(25.0))
            p = np.asarray(p) + np.asarray(wp.quat_rotate(q, edge)) - np.asarray(wp.quat_rotate(tilted, edge))
            q = tilted
        body = b.add_body(xform=tf(p, q))
        b.add_shape_box(body, hx=0.005, hy=0.025, hz=0.05, cfg=cfg(mu=0.4, density=650, gap=0.02), color=[BLUE, GOLD][i % 2])
        theta -= spacing / math.hypot(r, k)
    return b, twists, "Ground plane: 480 dominoes topple in a chain along a spiral on an infinite plane."


def bounce():
    """Restitution: five balls, each on a pad of the same restitution (0 ... 0.9), dropped from 0.8 m."""
    b = builder()
    b.add_ground_plane()
    twists = {}
    for i, e in enumerate((0.0, 0.25, 0.5, 0.75, 0.9)):
        x = (i - 2) * 0.25
        b.add_shape_box(-1, xform=tf((x, 0, 0.02)), hx=0.1, hy=0.1, hz=0.02, cfg=cfg(restitution=e), color=GREY)
        body = b.add_body(xform=tf((x, 0, 0.8)))
        b.add_shape_sphere(body, radius=0.04, cfg=cfg(restitution=e, density=1000), color=[BLUE, TEAL, GOLD, RED, BLUE][i])
    return b, twists, "Restitution: balls on pads of restitution 0, 0.25, 0.5, 0.75 and 0.9, left to right."


def spin_roll():
    """Torsional and rolling friction on free bodies (steel:condim 6): per lane, a spinning ball and a rolling ball."""
    b = builder()
    newton.solvers.SolverSteel.register_custom_attributes(b)
    b.add_ground_plane(cfg=cfg(mu=0.6))
    twists = {}
    # Free-body contacts take the larger condim-enabled coefficient of the pair (the ground stays condim 3).
    for mt, mr, y, color in ((0.0, 0.0, 0.3, GREY), (0.02, 0.004, -0.3, GOLD)):
        ball_cfg = cfg(mu=0.6, mu_torsional=mt, mu_rolling=mr, density=800)
        custom = {"steel:condim": 6} if mt > 0 else None
        spinner = b.add_body(xform=tf((-0.6, y, 0.05)))
        b.add_shape_sphere(spinner, radius=0.05, cfg=ball_cfg, color=color, custom_attributes=custom)
        twists[spinner] = (0, 0, 0, 0, 0, 25.0)
        roller = b.add_body(xform=tf((-0.4, y, 0.05)))
        b.add_shape_sphere(roller, radius=0.05, cfg=ball_cfg, color=color, custom_attributes=custom)
        twists[roller] = (0.8, 0, 0, 0, 0.8 / 0.05, 0)
    return b, twists, "Torsional and rolling friction (steel:condim 6 on the gold balls): the grey lane keeps spinning and rolling; the gold lane stops."

def ragdoll():
    """Floating base: a jointed figure with a free-floating torso tumbling down stairs."""
    b = builder()
    b.add_ground_plane()
    for k in range(6):
        h = 0.08 * (5 - k) + 0.04
        b.add_shape_box(-1, xform=tf((0.22 * k, 0, h / 2)), hx=0.11, hy=0.4, hz=h / 2, color=GREY)
    body_cfg = cfg(mu=0.8, density=1000)
    start = np.array((-0.05, 0.0, 0.95))
    torso = b.add_link(xform=tf(start, wp.quat_rpy(0.4, 0.5, 0.0)))
    b.add_shape_capsule(torso, radius=0.07, half_height=0.12, cfg=body_cfg, color=BLUE)
    joints = [b.add_joint_free(torso)]
    head = b.add_link(xform=tf(start + (0, 0, 0.29)))
    b.add_shape_sphere(head, radius=0.08, cfg=body_cfg, color=GOLD)
    joints.append(b.add_joint_ball(torso, head, parent_xform=tf((0, 0, 0.2)), child_xform=tf((0, 0, -0.09))))
    limbs = [((0.0, 0.16, 0.17), (1, 0, 0)), ((0.0, -0.16, 0.17), (1, 0, 0)), ((0.0, 0.06, -0.2), (0, 1, 0)), ((0.0, -0.06, -0.2), (0, 1, 0))]
    for anchor, axis in limbs:
        down = -0.12
        upper = b.add_link(xform=tf(start + anchor + (0, 0, down)))
        b.add_shape_capsule(upper, radius=0.035, half_height=0.08, cfg=body_cfg, color=TEAL)
        joints.append(b.add_joint_ball(torso, upper, parent_xform=tf(anchor), child_xform=tf((0, 0, 0.12))))
        lower = b.add_link(xform=tf(start + anchor + (0, 0, 2 * down)))
        b.add_shape_capsule(lower, radius=0.03, half_height=0.08, cfg=body_cfg, color=TEAL)
        joints.append(
            b.add_joint_revolute(upper, lower, parent_xform=tf((0, 0, -0.12)), child_xform=tf((0, 0, 0.12)), axis=axis,
                                 limit_lower=-2.2, limit_upper=0.0)
        )
    b.add_articulation(joints)
    return b, {torso: (2.0, 0, 0.3, 0, 4.0, 0)}, "Floating base: a 10-body ragdoll with a free-floating torso is thrown onto a staircase."


def d6():
    """D6 joints: a driven 2-translation + yaw gantry carrying a pendulum, a universal joint and a gimbal."""
    b = builder()
    b.add_ground_plane()
    D = newton.ModelBuilder.JointDofConfig
    link_cfg = cfg(density=500)
    # Gantry: x/y slides limited to +-0.3 m and driven to (0.25, -0.2); yaw driven to 1 rad.
    head = b.add_link(xform=tf((-0.4, 0, 0.9)))
    b.add_shape_box(head, hx=0.08, hy=0.08, hz=0.03, cfg=link_cfg, color=GOLD)
    slide = dict(limit_lower=-0.3, limit_upper=0.3, target_ke=400.0, target_kd=40.0, armature=0.05)
    j0 = b.add_joint_d6(
        -1, head, parent_xform=tf((-0.4, 0, 0.9)),
        linear_axes=[D(axis=(1, 0, 0), target_pos=0.25, **slide), D(axis=(0, 1, 0), target_pos=-0.2, **slide)],
        angular_axes=[D(axis=(0, 0, 1), target_pos=1.0, target_ke=40.0, target_kd=4.0, armature=0.01)],
    )
    bob = b.add_link(xform=tf((-0.4, 0, 0.55)))
    b.add_shape_capsule(bob, radius=0.025, half_height=0.15, cfg=link_cfg, color=BLUE)
    j1 = b.add_joint_ball(head, bob, parent_xform=tf((0, 0, -0.03)), child_xform=tf((0, 0, 0.17)))
    b.add_articulation([j0, j1])
    # Universal joint released from a tilt; its first axis stops at -0.15 rad on the return swing.
    u = b.add_link(xform=tf((0.3, 0.25, 0.6)))
    b.add_shape_box(u, hx=0.02, hy=0.02, hz=0.18, cfg=link_cfg, color=TEAL)
    lim = dict(limit_lower=-0.5, limit_upper=0.5)
    ju = b.add_joint_d6(-1, u, parent_xform=tf((0.3, 0.25, 0.8)), child_xform=tf((0, 0, 0.2)),
                        angular_axes=[D(axis=(1, 0, 0), limit_lower=-0.15, limit_upper=0.5), D(axis=(0, 1, 0), **lim)])
    b.add_articulation([ju])
    # Gimbal: three rotations, each limited.
    g = b.add_link(xform=tf((0.3, -0.25, 0.6)))
    b.add_shape_box(g, hx=0.12, hy=0.02, hz=0.02, cfg=link_cfg, color=RED)
    b.add_shape_box(g, xform=tf((0, 0, 0.1)), hx=0.015, hy=0.015, hz=0.1, cfg=link_cfg, color=RED)
    jg = b.add_joint_d6(-1, g, parent_xform=tf((0.3, -0.25, 0.8)), child_xform=tf((0, 0, 0.2)),
                        angular_axes=[D(axis=(1, 0, 0), **lim), D(axis=(0, 1, 0), **lim), D(axis=(0, 0, 1), limit_lower=-1.0, limit_upper=1.0)])
    b.add_articulation([jg])
    model_q = {"universal": (ju, (0.45, 0.3)), "gimbal": (jg, (0.4, -0.35, 0.0))}
    return b, {}, "D6 joints: a driven gantry (two slides and yaw) carrying a pendulum, a universal joint that stops on a limit, and a gimbal.", model_q


def vel_limit():
    """Joint velocity limits: two double pendulums released horizontal; the gold one has |qd| <= 1.5 rad/s."""
    b = builder()
    b.add_ground_plane()
    for y, vmax, color in ((0.25, 1e6, GREY), (-0.25, 1.5, GOLD)):
        prev, joints = -1, []
        for k in range(2):
            link = b.add_link(xform=tf((0.15 + 0.3 * k, y, 0.8)))
            b.add_shape_capsule(link, xform=tf(q=wp.quat_rpy(0.0, math.pi / 2, 0.0)), radius=0.03, half_height=0.12,
                                cfg=cfg(density=800), color=color)
            parent_xform = tf((0, y, 0.8)) if prev < 0 else tf((0.15, 0, 0))
            joints.append(b.add_joint_revolute(prev, link, parent_xform=parent_xform, child_xform=tf((-0.15, 0, 0)),
                                               axis=(0, 1, 0), velocity_limit=vmax))
            prev = link
        b.add_articulation(joints)
    return b, {}, "Velocity limits: the grey double pendulum swings freely; the gold one is held to 1.5 rad/s per joint.", {}


def linkages():
    """Mimic joints and a revolute loop closure: mirrored pendulums and a crank-driven four-bar."""
    b = builder()
    b.add_ground_plane()
    bar = cfg(density=600)
    # Mimic: the leader swings freely; the followers copy it with multipliers -1 and 0.5.
    pend = []
    for k, (y, color) in enumerate(((-0.15, GOLD), (0.0, BLUE), (0.15, TEAL))):
        link = b.add_link(xform=tf((-0.3, y, 0.45)))
        b.add_shape_capsule(link, radius=0.015, half_height=0.11, cfg=bar, color=color)
        b.add_shape_sphere(link, xform=tf((0, 0, -0.13)), radius=0.035, cfg=bar, color=color)
        j = b.add_joint_revolute(-1, link, parent_xform=tf((-0.3, y, 0.6)), child_xform=tf((0, 0, 0.15)), axis=(0, 1, 0))
        pend.append(j)
    b.add_articulation(pend)
    b.set_joint_mimic(pend[1], pend[0], coeffs=(0.0, -1.0))
    b.set_joint_mimic(pend[2], pend[0], coeffs=(0.0, 0.5))
    # Four-bar: ground pivots A and D, crank AB driven at 2 rad/s, rocker closed to D by a revolute loop.
    A = np.array((0.15, 0.0, 0.3)); D = np.array((0.45, 0.0, 0.3))
    B = A + (0.0, 0.0, 0.1)
    lc, lr = 0.3, 0.2
    d = np.linalg.norm(D - B); a = (lc**2 - lr**2 + d**2) / (2 * d); h = math.sqrt(lc**2 - a**2)
    u = (D - B) / d; perp = np.array((-u[2], 0.0, u[0]))
    C = B + a * u + h * perp
    def seg(body, p0, p1, color):
        mid, v = (np.asarray(p0) + np.asarray(p1)) / 2, np.asarray(p1) - np.asarray(p0)
        q = wp.quat_between_vectors(wp.vec3(0.0, 0.0, 1.0), wp.vec3(*(v / np.linalg.norm(v))))
        b.add_shape_capsule(body, xform=tf(mid - p0, q), radius=0.012, half_height=float(np.linalg.norm(v)) / 2, cfg=bar, color=color)
    crank = b.add_link(xform=tf(A)); seg(crank, A, B, RED)
    coupler = b.add_link(xform=tf(B)); seg(coupler, B, C, GOLD)
    rocker = b.add_link(xform=tf(C)); seg(rocker, C, D, BLUE)
    y = (0, 1, 0)
    j0 = b.add_joint_revolute(-1, crank, parent_xform=tf(A), axis=y, target_vel=2.0, target_kd=5.0)
    j1 = b.add_joint_revolute(crank, coupler, parent_xform=tf(B - A), axis=y)
    j2 = b.add_joint_revolute(coupler, rocker, parent_xform=tf(C - B), axis=y)
    b.add_articulation([j0, j1, j2])
    b.add_joint_revolute(-1, rocker, parent_xform=tf(D), child_xform=tf(D - C), axis=y)
    start = {"leader": (pend[0], (0.8,)), "mirror": (pend[1], (-0.8,)), "half": (pend[2], (0.4,))}
    return b, {}, "Mimic and loop closure: two pendulums copy the gold one (x -1, x 0.5); a crank drives a four-bar closed by a revolute loop.", start


def incline():
    """Friction anchors: boxes and short stacks on a 22 deg incline with mu 0.5."""
    b = builder()
    b.add_ground_plane()
    ang = math.radians(22)
    q = wp.quat_from_axis_angle(wp.vec3(0.0, 1.0, 0.0), -ang)
    n = np.array(wp.quat_rotate(q, wp.vec3(0.0, 0.0, 1.0)))
    b.add_shape_box(-1, xform=tf((0, 0, 0.35), q), hx=0.6, hy=0.45, hz=0.02, cfg=cfg(mu=0.5), color=GREY)
    for y, levels in ((-0.25, 1), (0.0, 2), (0.25, 3)):
        for k in range(levels):
            c = np.array((0, y, 0.35)) + n * (0.02 + 0.03 + 0.06 * k + 0.0005 * (k + 1))
            body = b.add_body(xform=tf(c, q))
            b.add_shape_box(body, hx=0.075, hy=0.075, hz=0.03, cfg=cfg(mu=0.5, density=400), color=[BLUE, TEAL, GOLD, RED][k])
    return b, {}, "Friction anchors: a box and stacks of 2 and 3 rest on a 22 deg incline (mu 0.5) without creeping."

def overlap():
    """Velocity pass: boxes spawned 15 mm into each other and the floor."""
    b = builder()
    b.add_ground_plane()
    for i in range(5):
        for k in range(4):
            body = b.add_body(xform=tf(((i - 2) * 0.13, 0.0, 0.035 + 0.055 * k), wp.quat_rpy(0.0, 0.0, 0.3 * k)))
            b.add_shape_box(body, hx=0.05, hy=0.05, hz=0.035, cfg=cfg(density=400), color=[BLUE, TEAL, GOLD, RED][k])
    return b, {}, "Velocity pass: 20 boxes start 15 mm deep in each other; with velocity_iterations the push-out does not launch them."


def rods():
    """Coupled friction (friction_mode): tall blocks launched sliding on a high-friction floor."""
    b = builder()
    b.add_ground_plane(cfg=cfg(mu=0.9))
    twists = {}
    for i, v in enumerate((1.0, 1.5, 2.0, 2.5, 3.0)):
        body = b.add_body(xform=tf((-0.6, (i - 2) * 0.18, 0.12)))
        b.add_shape_box(body, hx=0.03, hy=0.05, hz=0.12, cfg=cfg(mu=0.9, density=600), color=[BLUE, TEAL, GOLD, RED, GREY][i])
        twists[body] = (v, 0, 0, 0, 0, 0)
    return b, twists, "Coupled friction: tall blocks launched at 1 to 3 m/s on a mu 0.9 floor slide and tip; with friction_mode bisection_desaxce (normal target mu |v_t|) sliding blocks hop."

def drives():
    """Drive rows (drive_mode="rows"): arms stepping to 1.2 rad with effort limits 3, 10 and 60 N m, capped at 2 rad/s."""
    b = builder()
    b.add_ground_plane()
    joints = []
    for i, effort in enumerate((3.0, 10.0, 60.0)):
        y = (i - 1) * 0.3
        base = b.add_link(xform=tf((0.0, y, 0.5)))
        b.add_shape_box(base, xform=tf((0.2, 0, 0)), hx=0.2, hy=0.02, hz=0.02, cfg=cfg(density=500), color=[BLUE, TEAL, GOLD][i])
        b.add_shape_sphere(base, xform=tf((0.4, 0, 0)), radius=0.05, cfg=cfg(density=3000), color=RED)
        j = b.add_joint_revolute(-1, base, parent_xform=tf((0.0, y, 0.5)), axis=(0, -1, 0), target_pos=1.2, target_ke=2000.0,
                                 target_kd=60.0, effort_limit=effort, velocity_limit=2.0)
        b.add_articulation([j])
        joints.append(j)
    return b, {}, "Drive rows: arms driven to 1.2 rad with effort limits 3, 10 and 60 N m and a 2 rad/s velocity limit (drive_mode rows)."


def body_limits():
    """Steel's per-body attributes: max linear velocity, max angular velocity and angular damping."""
    b = builder()
    newton.solvers.SolverSteel.register_custom_attributes(b)
    b.add_ground_plane(cfg=cfg(mu=0.0))
    twists = {}
    rows = (
        ("max linear velocity 1 m/s", {"steel:rigid_body_max_linear_velocity": 1.0}, (0.0, 0.0, 0.0, 0.0, 0.0, 0.0), 1.6),
        ("max angular velocity 5 rad/s", {"steel:rigid_body_max_angular_velocity": 5.0}, (0.0, 0.0, 0.0, 0.0, 0.0, 30.0), 0.3),
        ("angular damping 2 /s", {"steel:rigid_body_angular_damping": 2.0}, (0.0, 0.0, 0.0, 0.0, 0.0, 30.0), 0.3),
    )
    for i, (_, custom, tw, z) in enumerate(rows):
        for k, limited in enumerate((False, True)):
            body = b.add_body(xform=tf((-0.4 + 0.4 * i, -0.15 + 0.3 * k, z)), custom_attributes=custom if limited else None)
            b.add_shape_box(body, hx=0.05, hy=0.05, hz=0.05, cfg=cfg(density=500, mu=0.0), color=[GREY, GOLD][k])
            twists[body] = tw
    return b, twists, "Per-body limits (gold vs grey): a 1 m/s fall cap, a 5 rad/s spin cap and 2 /s angular damping on frictionless spinners."


def sleeping():
    """Sleeping: 36 boxes in short stacks settle and stop being simulated until touched."""
    b = builder()
    b.add_ground_plane()
    rng = np.random.default_rng(3)
    k = 0
    for gx in range(4):
        for gy in range(3):
            for level in range(3):
                p = ((gx - 1.5) * 0.18 + rng.uniform(-0.01, 0.01), (gy - 1) * 0.18, 0.04 + 0.08 * level + 0.02 * level)
                body = b.add_body(xform=tf(p, wp.quat_rpy(0.0, 0.0, rng.uniform(-0.4, 0.4))))
                b.add_shape_box(body, hx=0.035, hy=0.035, hz=0.035, cfg=cfg(density=400), color=[BLUE, TEAL, GOLD, RED][k % 4])
                k += 1
    return b, {}, "Sleeping: 36 boxes in short stacks settle and fall asleep (no rows, no integration); drag one to wake its island."

def torsion():
    """Contact torsion: sphere-tipped grippers pinch a bar 8 cm from its center; only the gold pair has a torsion radius."""
    b = builder()
    newton.solvers.SolverSteel.register_custom_attributes(b)
    b.add_ground_plane()
    for y, radius, color in ((0.25, 0.0, GREY), (-0.25, 0.01, GOLD)):
        tip_cfg = cfg(mu=0.8, density=2000)
        custom = {"steel:min_torsional_patch_radius": radius} if radius > 0 else None
        base = b.add_link(xform=tf((0.0, y, 0.5)))
        b.add_shape_box(base, xform=tf((0.0, 0.0, 0.08)), hx=0.02, hy=0.06, hz=0.01, cfg=cfg(density=500), color=GREY)
        joints = [b.add_joint_fixed(-1, base, parent_xform=tf((0.0, y, 0.5)))]
        for side in (1.0, -1.0):
            finger = b.add_link(xform=tf((0.0, y + side * 0.022, 0.5)))
            b.add_shape_box(finger, xform=tf((0.0, side * 0.01, 0.04)), hx=0.008, hy=0.004, hz=0.04, cfg=cfg(density=500), color=color)
            b.add_shape_sphere(finger, radius=0.012, cfg=tip_cfg, color=color, custom_attributes=custom)
            joints.append(b.add_joint_prismatic(base, finger, parent_xform=tf((0.0, side * 0.022, 0.0)), axis=(0, side, 0),
                                                target_pos=-0.004, target_ke=3000.0, target_kd=50.0, effort_limit=30.0,
                                                limit_lower=-0.02, limit_upper=0.03))
        b.add_articulation(joints)
        bar = b.add_body(xform=tf((0.08, y, 0.5)))
        b.add_shape_box(bar, hx=0.12, hy=0.01, hz=0.025, cfg=cfg(mu=0.8, density=500), color=[BLUE, TEAL][y < 0])
    return b, {}, "Contact torsion: sphere fingertips pinch a bar off its center; the gold tips (min_torsional_patch_radius 1 cm) hold it level, the grey ones let it swing."


def dumbbells():
    """Articulated torsional and rolling friction (elliptic cone): a rolling and a spinning dumbbell."""
    b = builder()
    b.add_ground_plane(cfg=cfg(mu=0.6, mu_torsional=0.01, mu_rolling=0.01))
    twists = {}
    ball = cfg(mu=0.6, mu_torsional=0.01, mu_rolling=0.01, density=800)
    for x, y, twist, color in ((-0.4, 0.2, (0.8, 0, 0, 0, 0.8 / 0.05, 0), BLUE), (0.2, -0.2, (0, 0, 0, 0, 0, 20.0), GOLD)):
        root = b.add_link(xform=tf((x, y - 0.07, 0.05)))
        b.add_shape_sphere(root, radius=0.05, cfg=ball, color=color)
        other = b.add_link(xform=tf((x, y + 0.07, 0.05)))
        b.add_shape_sphere(other, radius=0.05, cfg=ball, color=color)
        b.add_shape_capsule(other, xform=tf((0, -0.07, 0), wp.quat_rpy(math.pi / 2, 0.0, 0.0)), radius=0.012, half_height=0.05, cfg=cfg(density=300), color=GREY)
        j0 = b.add_joint_free(root)
        j1 = b.add_joint_fixed(root, other, parent_xform=tf((0, 0.14, 0)))
        b.add_articulation([j0, j1])
        twists[root] = twist
    return b, twists, "Articulated torsional and rolling friction: a rolling and a spinning dumbbell (floating-base articulations) stop under enable_torsional_rolling_friction."


def compliance():
    """Contact compliance: 1 kg blocks on springs of 1e3, 1e4 and 1e5 N/m (shape ke, series with a stiff ground)."""
    b = builder()
    b.add_ground_plane(cfg=cfg(ke=1.0e7, kd=0.0))
    for i, (ke, kd) in enumerate(((1.0e3, 20.0), (1.0e4, 60.0), (1.0e5, 200.0))):
        body = b.add_body(xform=tf(((i - 1) * 0.25, 0.0, 0.3)))
        b.add_shape_box(body, hx=0.05, hy=0.05, hz=0.05, cfg=cfg(ke=ke, kd=kd, density=1000), color=[RED, GOLD, TEAL][i])
    return b, {}, "Contact compliance: 1 kg blocks with contact stiffness 1e3, 1e4 and 1e5 N/m drop and settle about 10, 1 and 0.1 mm into the ground."


def load_friction():
    """Load-dependent joint friction: two loaded pendulums, the gold hinge with joint_friction_load_coefficient 0.4."""
    b = builder()
    newton.solvers.SolverSteel.register_custom_attributes(b)
    b.add_ground_plane()
    joints = []
    for y, coef, color in ((0.2, 0.0, GREY), (-0.2, 0.4, GOLD)):
        arm = b.add_link(xform=tf((0.0, y, 0.6)))
        b.add_shape_capsule(arm, xform=tf((0.15, 0, 0), wp.quat_rpy(0.0, math.pi / 2, 0.0)), radius=0.012, half_height=0.15, cfg=cfg(density=300), color=GREY)
        b.add_shape_sphere(arm, xform=tf((0.3, 0, 0)), radius=0.05, cfg=cfg(density=4000), color=color)
        j = b.add_joint_revolute(-1, arm, parent_xform=tf((0.0, y, 0.6)), axis=(0, 1, 0),
                                 custom_attributes={"steel:joint_friction_load_coefficient": coef})
        b.add_articulation([j])
        joints.append(j)
    start = {"grey": (joints[0], (-0.8,)), "gold": (joints[1], (-0.8,))}
    return b, {}, "Load-dependent joint friction: two loaded pendulums released at 45 deg; the gold hinge's friction grows with the load it carries and holds it.", start


def kinematic():
    """Kinematic bodies: a kinematic paddle sweeps boxes at a prescribed spin; a gravity-free box floats."""
    b = builder()
    b.add_ground_plane()
    paddle = b.add_body(xform=tf((0.0, 0.0, 0.05)), is_kinematic=True)
    b.add_shape_box(paddle, hx=0.42, hy=0.015, hz=0.04, cfg=cfg(density=500), color=RED)
    twists = {paddle: (0.0, 0.0, 0.0, 0.0, 0.0, 1.2)}
    for k in range(10):
        a = 2 * math.pi * k / 10
        body = b.add_body(xform=tf((0.32 * math.cos(a), 0.32 * math.sin(a), 0.03)))
        b.add_shape_box(body, hx=0.03, hy=0.03, hz=0.03, cfg=cfg(density=300), color=[BLUE, TEAL, GOLD][k % 3])
    floater = b.add_body(xform=tf((0.0, 0.0, 0.4)), disable_gravity=True)
    b.add_shape_box(floater, hx=0.04, hy=0.04, hz=0.04, cfg=cfg(density=300), color=GOLD)
    twists[floater] = (0.0, 0.0, 0.0, 0.3, 0.5, 0.0)
    return b, twists, "Kinematic bodies: a kinematic paddle (prescribed 1.2 rad/s spin, infinite mass) sweeps boxes; the gold box above has gravity disabled."


# Scenes after avbd-metal's demos (Sources/GPUSimDemos), in its metre scale; densities in kg/m^3.
def card_house():
    """Card house: four levels of leaning cards and flat separators held up by friction alone."""
    b = builder()
    b.add_ground_plane(cfg=cfg(mu=0.9))
    w, t, depth, theta = 1.2, 0.05, 1.0, 1.22
    foot, h = w * math.cos(theta), w * math.sin(theta)
    pitch = 2 * foot + 0.15
    card = cfg(density=200, mu=0.9)
    levels = 4
    for level in range(levels):
        n = levels - level
        z0 = level * (h + t + t * math.cos(theta))
        x0 = -(n - 1) * pitch / 2
        for i in range(n):
            cx = x0 + i * pitch
            for side in (-1, 1):
                # Faces (not mid-planes) meet at the apex, and the lower corners rest on the floor.
                x = cx + side * (foot / 2 + t / (2 * math.sin(theta)))
                body = b.add_body(xform=tf((x, 0, z0 + h / 2 + t / 2 * math.cos(theta)), wp.quat_from_axis_angle(wp.vec3(0, 1, 0), side * theta)))
                b.add_shape_box(body, hx=w / 2, hy=depth / 2, hz=t / 2, cfg=card, color=[BLUE, TEAL, GOLD, RED][(level + i) % 4])
        if level < levels - 1:
            for i in range(n - 1):
                body = b.add_body(xform=tf((x0 + (i + 0.5) * pitch, 0, z0 + h + t * math.cos(theta) + t / 2)))
                b.add_shape_box(body, hx=pitch * 1.05 / 2, hy=depth / 2, hz=t / 2, cfg=card, color=GREY)
    return b, {}, "Card house: four levels of leaning cards and flat separators stand on friction alone."


def ratio_stack():
    """Mass-ratio stack: six cubes, each about 3x the mass of the one below (about 270:1 overall)."""
    b = builder()
    b.add_ground_plane(cfg=cfg(mu=0.8))
    side, z = 0.5, 0.0
    for k in range(6):
        z += side / 2
        body = b.add_body(xform=tf((0, 0, z)))
        b.add_shape_box(body, hx=side * 0.49, hy=side * 0.49, hz=side * 0.49, cfg=cfg(density=1000, mu=0.8), color=[BLUE, TEAL, GOLD, RED][k % 4])
        z += side / 2
        side *= 1.45
    return b, {}, "Mass-ratio stack: six cubes, each about 3x heavier than the one below. Momentum keeps the tower standing; switch it off and it topples within seconds."


def trebuchet():
    """Trebuchet: a hinged arm with a hung counterweight throws a boulder from a cup at a dry brick wall."""
    b = builder()
    b.add_ground_plane(cfg=cfg(mu=0.9))
    pivot_z, short_arm, long_arm, cock = 4.2, 1.5, 5.2, 0.7  # avbd cocks to 0.98 rad, which buries the cup
    frame = [b.add_shape_box(-1, xform=tf((0, sy * 1.5, pivot_z / 2)), hx=0.25, hy=0.25, hz=pivot_z / 2, cfg=cfg(mu=0.8), color=GREY) for sy in (-1, 1)]
    frame.append(b.add_shape_box(-1, xform=tf((0, 0, pivot_z)), hx=0.3, hy=1.2, hz=0.3, cfg=cfg(mu=0.5), color=GREY))
    q_arm = wp.quat_from_axis_angle(wp.vec3(0, 1, 0), -cock)
    off = (long_arm - short_arm) / 2
    pivot = wp.vec3(0, 0, pivot_z)
    arm_c = pivot + wp.quat_rotate(q_arm, wp.vec3(-off, 0, 0))
    arm = b.add_link(xform=wp.transform(arm_c, q_arm), label="arm")
    b.add_shape_box(arm, hx=(long_arm + short_arm) / 2, hy=0.2, hz=0.175, cfg=cfg(density=2500, mu=0.5), color=(0.55, 0.38, 0.22))
    # The cup is welded to the arm: its parts are arm shapes in the arm frame.
    tip = wp.vec3(-long_arm + off, 0, 0)
    for size, p in (((1.5, 1.3, 0.12), (0, 0, 0.24)), ((0.14, 1.3, 0.6), (0.72, 0, 0.55)), ((0.14, 1.3, 0.42), (-0.72, 0, 0.46)),
                    ((1.5, 0.12, 0.5), (0, 0.66, 0.5)), ((1.5, 0.12, 0.5), (0, -0.66, 0.5))):
        b.add_shape_box(arm, xform=tf(tip + wp.vec3(*p)), hx=size[0] / 2, hy=size[1] / 2, hz=size[2] / 2, cfg=cfg(density=600, mu=0.5), color=(0.45, 0.30, 0.18))
    # The arm turns inside the axle housing, as a joint's bodies do not collide.
    for a in [i for i, owner in enumerate(b.shape_body) if owner == arm]:
        for f in frame:
            b.add_shape_collision_filter_pair(a, f)
    j_arm = b.add_joint_revolute(-1, arm, axis=(0, 1, 0), parent_xform=wp.transform(pivot, q_arm), child_xform=tf((off, 0, 0)))
    anchor = wp.vec3(short_arm + off, 0, 0)
    cw_pos = pivot + wp.quat_rotate(q_arm, wp.vec3(short_arm, 0, 0)) + wp.vec3(0, 0, -1.15)
    cw = b.add_link(xform=tf(cw_pos), label="counterweight")
    b.add_shape_box(cw, hx=0.85, hy=0.85, hz=0.75, cfg=cfg(density=10000, mu=0.6), color=GREY)
    j_cw = b.add_joint_ball(arm, cw, parent_xform=wp.transform(anchor, wp.quat_inverse(q_arm)), child_xform=tf((0, 0, 1.15)))
    b.add_articulation([j_arm, j_cw])
    up = wp.quat_rotate(q_arm, wp.vec3(0, 0, 1))
    boulder = b.add_body(xform=tf(pivot + wp.quat_rotate(q_arm, wp.vec3(-long_arm, 0, 0)) + up * 0.85))
    b.add_shape_sphere(boulder, radius=0.55, cfg=cfg(density=3000, mu=0.4), color=(0.35, 0.33, 0.30))
    b.add_shape_box(-1, xform=tf((-1.9, 0, pivot_z + 2.9)), hx=0.35, hy=2.1, hz=0.35, cfg=cfg(mu=0.9), color=GREY)
    # Dry-stacked brick wall downrange (avbd-metal's castle is mortared; the port has no breakable joints).
    brick = (1.1, 0.55, 0.55)
    for h in range(8):
        # Running bond: offset courses carry one brick fewer so no brick overhangs the end.
        for i in range(10 - h % 2):
            y = -4.5 * brick[0] + i * brick[0] + (brick[0] / 2 if h % 2 else 0)
            body = b.add_body(xform=tf((31.5, y, h * brick[2] + brick[2] / 2)))
            b.add_shape_box(body, hx=brick[1] * 0.93 / 2, hy=brick[0] * 0.93 / 2, hz=brick[2] / 2, cfg=cfg(density=800, mu=0.85), color=[(0.72, 0.45, 0.33), (0.62, 0.38, 0.28)][(h + i) % 2])
    return b, {}, "Trebuchet: a hinged arm with a hung counterweight throws a boulder from its cup at a dry-stacked brick wall."


SCENES = {"dominoes": dominoes, "bounce": bounce, "spin_roll": spin_roll, "ragdoll": ragdoll, "d6": d6, "vel_limit": vel_limit, "linkages": linkages, "incline": incline, "overlap": overlap, "rods": rods, "drives": drives, "body_limits": body_limits, "sleeping": sleeping, "torsion": torsion, "dumbbells": dumbbells, "compliance": compliance, "load_friction": load_friction, "kinematic": kinematic, "card_house": card_house, "ratio_stack": ratio_stack, "trebuchet": trebuchet}
SOLVER = {"vel_limit": {"enable_joint_velocity_limits": True}, "incline": {"contact_regularization": 0.0}, "overlap": {"velocity_iterations": 4}, "rods": {"friction_mode": "bisection_desaxce"}, "drives": {"drive_mode": "rows", "enable_joint_velocity_limits": True}, "sleeping": {"enable_sleeping": True}, "dumbbells": {"enable_torsional_rolling_friction": True, "friction_anchor_beta": 0.0}, "compliance": {"contact_compliance": True, "enable_restitution": False}, "load_friction": {"enable_joint_friction": True}, "ratio_stack": {"substeps": 8, "iterations": 16, "nesterov_momentum": True}, "trebuchet": {"nesterov_momentum": True, "enable_sleeping": True}, "dominoes": {"enable_sleeping": True}, "card_house": {"enable_sleeping": True}}


COMPARE = {
    "compliance": {"option": "contact_compliance", "off": False, "label": "Soft contacts"},
    "dumbbells": {"option": "enable_torsional_rolling_friction", "off": False, "label": "Rolling and spinning friction"},
    "drives": {"option": "drive_mode", "off": "augmented", "label": "Joint motor constraints"},
    "rods": {"option": "friction_mode", "off": "fixed_normal", "label": "Coupled friction"},
    "overlap": {"option": "velocity_iterations", "off": 0, "label": "Velocity cleanup pass"},
    "incline": {"option": "friction_anchor_beta", "off": 0.0, "label": "Friction anchors"},
}
CAMERA = {
    "dominoes": {"eye": (0.0, -2.9, 3.3), "target": (0.0, 0.25, 0.0)},
    "card_house": {"eye": (3.5, -6.0, 3.6), "target": (0.0, 0.0, 1.8)},
    "ratio_stack": {"eye": (12.0, -20.0, 9.0), "target": (0.0, 0.0, 4.5)},
    "trebuchet": {"eye": (6.0, -30.0, 10.0), "target": (16.0, 0.0, 4.0)},
    "ragdoll": {"eye": (0.6, -2.6, 1.4), "target": (0.6, 0.0, 0.35)},
    "d6": {"eye": (0.9, -2.0, 1.3), "target": (-0.05, 0.0, 0.6)},
    "vel_limit": {"eye": (0.3, -2.0, 1.1), "target": (0.3, 0.0, 0.55)},
    "kinematic": {"eye": (0.6, -1.2, 0.8), "target": (0.0, 0.0, 0.1)},
    "load_friction": {"eye": (0.4, -1.3, 0.8), "target": (0.1, 0.0, 0.5)},
    "compliance": {"eye": (0.3, -1.0, 0.35), "target": (0.0, 0.0, 0.05)},
    "dumbbells": {"eye": (0.0, -1.4, 0.6), "target": (0.0, 0.0, 0.05)},
    "torsion": {"eye": (0.5, -1.0, 0.7), "target": (0.05, 0.0, 0.45)},
    "sleeping": {"eye": (0.6, -1.0, 0.7), "target": (0.0, 0.0, 0.08)},
    "body_limits": {"eye": (0.0, -2.0, 1.0), "target": (0.0, 0.0, 0.3)},
    "drives": {"eye": (0.6, -1.6, 0.9), "target": (0.2, 0.0, 0.5)},
    "rods": {"eye": (0.2, -1.6, 0.6), "target": (0.0, 0.0, 0.1)},
    "overlap": {"eye": (0.5, -1.3, 0.6), "target": (0.0, 0.0, 0.12)},
    "incline": {"eye": (0.4, -1.9, 1.1), "target": (0.0, 0.0, 0.4)},
    "linkages": {"eye": (0.6, -1.5, 0.8), "target": (0.05, 0.0, 0.4)},
}


def build(name, out_root):
    b, twists, about, *rest = SCENES[name]()
    model = b.finalize(device="cpu")
    if rest:
        # Initial joint coordinates for named joints.
        q = model.joint_q.numpy()
        qs = model.joint_q_start.numpy()
        for j, vals in rest[0].values():
            q[qs[j] : qs[j] + len(vals)] = vals
        model.joint_q.assign(q)
    tw = np.zeros((model.body_count, 6))
    for body, t in twists.items():
        tw[body] = t
    export_model(model, Path(out_root) / name, name=name, solver=SOLVER.get(name), twists=tw, info={"about": about, **({"camera": CAMERA[name]} if name in CAMERA else {}), **({"compare": COMPARE[name]} if name in COMPARE else {})})
    return about


def main(which, out_root):
    names = list(SCENES) if which == "all" else [which]
    index_path = Path(out_root) / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    for name in names:
        about = build(name, out_root)
        known = next((e for e in index if e["name"] == name), None)
        if not known:  # curated titles and descriptions in index.json are kept
            index.append({"name": name, "title": name.replace("_", " ").capitalize(), "about": about})
    index_path.write_text(json.dumps(index, indent=1) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
