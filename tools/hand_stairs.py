# SPDX-License-Identifier: Apache-2.0
"""A Wuji hand, cut loose from its arm, walks up a spiral staircase on its fingertips.

Takes the hand out of the exported ``toy_piano`` scene, gives the palm a free joint in place of its
fixed base, builds the staircase and bakes the walk as joint targets. The walk is planned here and
then walked once in the browser with the palm's pose fed back, so run the three side by side:

    python3 tools/hand_stairs.py                       # plans, then serves the walker on port 8791
    cd apps/viewer && bun run dev
    cd apps/viewer && bun scripts/drive.ts             # steps the scene against the walker

The plan is kinematic and statically stable. Every fingertip keeps footholds three to a tread and the
palm rides the stair slope above them, wrist up, so the whole pose follows from how far round the
staircase the palm is. One finger swings at a time, and the palm leans to keep the center of mass
over the four left standing.

Replayed blind, such a walk drifts: each step lands a fraction of a millimeter off and nothing brings
the hand back, until a fingertip meets a riser. So ``drive.ts`` steps the simulation frame by frame
and reports the palm; the walker aims each swinging finger at its foothold from where the palm really
is, and the targets it sends are what gets baked. ``--port 0`` skips this and leaves the blind walk.
"""

import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SOURCE = "toy_piano"
NAME = "hand_stairs"
FPS = 60
GRAVITY = 9.81

# Staircase [m, rad]: wedge treads round a column, climbing counterclockwise seen from above.
TREADS = 8
TREAD_ANGLE = math.radians(24)
RISE = 0.015
TREAD_INNER = 0.02
TREAD_OUTER = 0.34
COLUMN_RADIUS = 0.035
LANDING_ANGLE = math.radians(60)
WALK_RADIUS = 0.22

# Palm: the knuckle point that follows the staircase, its height over the stair slope, and how far
# below the slope the fingers point. Wrist up, a fingertip reaches behind the knuckles as well as ahead.
KNUCKLES = np.array([0.0, 0.0, 0.088])
KNUCKLE_HEIGHT = 0.073
NOSE_DOWN = math.radians(34)

# Feet, thumb first: offset toward the column from the palm's path, lead of the mid-stance foot over
# the knuckles, footholds per tread, and the room a foothold keeps from the riser ahead and from the
# nose of its own tread. Index and ring reach forward; thumb, middle and little finger stand behind.
FEET = [
    {"left": 0.032, "lead": -0.016, "steps": 3, "riser": 0.012, "nose": 0.010},
    {"left": 0.030, "lead": 0.055, "steps": 3, "riser": 0.013, "nose": 0.011},
    {"left": 0.003, "lead": -0.028, "steps": 3, "riser": 0.018, "nose": 0.012},
    {"left": -0.028, "lead": 0.048, "steps": 3, "riser": 0.013, "nose": 0.011},
    {"left": -0.038, "lead": -0.040, "steps": 3, "riser": 0.018, "nose": 0.012},
]
NAMES = ["thumb", "index", "middle", "ring", "little"]

# Gait: the swings of one tread share it in equal slots. A swing takes SWING of its slot, and a foot
# sheds or takes up its load over UNLOAD of a slot either side.
SWING = 0.66
UNLOAD = 0.14
SWING_CLEARANCE = 0.008
TREAD_SECONDS = 3.4
SETTLE_SECONDS = 1.0
HOLD_SECONDS = 2.5
RAMP_SECONDS = 1.2
START_ANGLE = math.radians(-40)
END_ANGLE = TREADS * TREAD_ANGLE + math.radians(31)

# Balance: how far inside the planted feet the center of mass stays, and the passes that lean the palm to keep it there.
SUPPORT_MARGIN = 0.012
LEAN_PASSES = 6

# Finger links: their radius, and the height the inverse kinematics keeps the finger joints over the stairs.
LINK_RADIUS = 0.0086
LINK_CLEARANCE = 0.004

# Finger drives: the hand's position gains and damping, scaled; standing on its fingertips loads the
# joints far more than pressing piano keys does. The targets lead the planned angles by LOAD_LEAD of
# the sag under the weight and SPEED_LEAD of the lag behind a moving target.
STIFFNESS = 3.0
DAMPING = 2.0
LOAD_LEAD = 0.5
SPEED_LEAD = 0.5

# Walker: the low-pass on the palm's measured drift, per frame, and how long a planted finger takes
# to be drawn from where it landed to where the plan has it.
DRIFT_FILTER = 0.2
STEP_FADE_SECONDS = 0.5


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def quat_to_mat(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def mat_to_quat(m):
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [s / 4, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, s / 4, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, s / 4, (m[1, 0] - m[0, 1]) / s]
    return q


def smoothstep(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


class Hand:
    """The Wuji hand of an exported scene: the palm link and five chains of four revolute joints."""

    def __init__(self, scene, blob):
        self.scene, self.blob = scene, blob
        B, J = scene["bodies"], scene["joints"]
        self.palm = next(b for b, label in enumerate(B["label"]) if label.endswith("right_palm_link"))
        self.fingers = []
        for j in range(J["count"]):
            if J["parent"][j] != self.palm:
                continue
            chain = [j]
            while True:
                nxt = [k for k in range(J["count"]) if J["parent"][k] == J["child"][chain[-1]]]
                if not nxt:
                    break
                chain.append(nxt[0])
            self.fingers.append(self._finger(chain))
        self.bodies = [self.palm] + [b for f in self.fingers for b in f["bodies"]]
        self.mass = sum(B["mass"][b] for b in self.bodies)

    def _finger(self, chain):
        B, J = self.scene["bodies"], self.scene["joints"]
        dofs = [J["qd_start"][j] for j in chain]
        bodies = [J["child"][j] for j in chain]
        # The fingertip pad: a round-ended hull at the end of the last link.
        pad = max((s for s in self.scene["shapes"] if s["body"] == bodies[-1]), key=lambda s: s["xf"][2])
        verts = np.frombuffer(self.blob, np.float32, pad["hull"]["verts"]["n"], pad["hull"]["verts"]["off"]).reshape(-1, 3)
        lo, hi = verts.min(axis=0), verts.max(axis=0)
        radius = float(hi[0] - lo[0]) / 2
        return {
            "joints": chain,
            "dofs": dofs,
            "bodies": bodies,
            "pos": [np.array(J["X_p"][j][:3]) for j in chain],
            "rot": [quat_to_mat(J["X_p"][j][3:]) for j in chain],
            "lower": np.array([J["lower"][d] for d in dofs]),
            "upper": np.array([J["upper"][d] for d in dofs]),
            "ke": np.array([J["ke"][d] for d in dofs]),
            "kd": np.array([J["kd"][d] for d in dofs]),
            "mass": [B["mass"][b] for b in bodies],
            "com": [np.array(B["com"][b]) for b in bodies],
            "tip": np.array(pad["xf"][:3]) + np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2] - radius]),
            "radius": radius,
        }

    def fk(self, f, q):
        """Joint frames of finger ``f`` (position, rotation; palm coordinates) and its tip center."""
        F = self.fingers[f]
        p, R, frames = np.zeros(3), np.eye(3), []
        for k in range(4):
            p = p + R @ F["pos"][k]
            R = R @ F["rot"][k] @ rot_y(q[k])
            frames.append((p, R))
        return frames, p + R @ F["tip"]

    def jacobian(self, frames, tip):
        return np.column_stack([np.cross(R[:, 1], tip - p) for p, R in frames])

    def ik(self, f, target, q, posture, iterations=40, clearance=None):
        """Joint angles putting the tip center of finger ``f`` at ``target``; returns them and the miss.

        ``clearance`` maps a point (palm coordinates) to its height over the ground and the upward direction;
        the two finger joints are then kept LINK_CLEARANCE above it.
        """
        F = self.fingers[f]
        q = np.clip(np.array(q, dtype=float), F["lower"], F["upper"])

        def rows(q):
            frames, tip = self.fk(f, q)
            A, e = self.jacobian(frames, tip), target - tip
            if clearance is not None:
                for k in (2, 3):
                    height, up = clearance(frames[k][0])
                    if height < LINK_CLEARANCE:
                        lift = np.zeros(4)
                        lift[:k] = [up @ np.cross(R[:, 1], frames[k][0] - p) for p, R in frames[:k]]
                        A, e = np.vstack([A, lift]), np.append(e, LINK_CLEARANCE - height)
            return A, e

        for _ in range(iterations):
            A, e = rows(q)
            free = np.ones(4, dtype=bool)
            # Damped least squares leaning toward `posture`; a joint pushed past a limit is held there and the rest re-solved.
            for _ in range(4):
                Af = A[:, free]
                weight = 2e-5 * np.eye(int(free.sum()))
                step = np.zeros(4)
                step[free] = np.linalg.solve(Af.T @ Af + weight + 1e-7 * np.eye(len(weight)), Af.T @ e + weight @ (posture - q)[free])
                step = np.clip(step, -0.2, 0.2)
                out = free & (((q + step) < F["lower"] - 1e-9) | ((q + step) > F["upper"] + 1e-9))
                if not out.any():
                    break
                q = np.where(out, np.clip(q + step, F["lower"], F["upper"]), q)
                free &= ~out
                A, e = rows(q)
            q = np.clip(q + step, F["lower"], F["upper"])
            if np.abs(step).max() < 1e-6:
                break
        return q, float(np.linalg.norm(target - self.fk(f, q)[1]))

    def center_of_mass(self, qs):
        """Center of mass in palm coordinates for the 5 x 4 joint angles ``qs``."""
        B = self.scene["bodies"]
        total = B["mass"][self.palm] * np.array(B["com"][self.palm])
        for f, F in enumerate(self.fingers):
            frames, _ = self.fk(f, qs[f])
            for (p, R), m, c in zip(frames, F["mass"], F["com"]):
                total = total + m * (p + R @ c)
        return total / self.mass


def ground_height(radius, angle):
    """Height of the walking surface at a polar position; ``angle`` runs along the climb (unwrapped)."""
    if not TREAD_INNER <= radius <= TREAD_OUTER or angle < 0:
        return 0.0
    if angle < TREADS * TREAD_ANGLE:
        return (math.floor(angle / TREAD_ANGLE) + 1) * RISE
    return (TREADS + 1) * RISE if angle <= TREADS * TREAD_ANGLE + LANDING_ANGLE else 0.0


def slope_height(angle):
    """The stair slope under the palm: a ramp through the tread centers, rounded where it meets the flats."""
    half = 0.6 * TREAD_ANGLE
    samples = np.linspace(angle - half, angle + half, 25)
    return float(np.mean(np.clip((samples / TREAD_ANGLE + 0.5) * RISE, 0.0, (TREADS + 1) * RISE)))


def heading(angle):
    """Forward and left (toward the column) for a palm ``angle`` round the staircase."""
    return np.array([-math.sin(angle), math.cos(angle), 0.0]), np.array([-math.cos(angle), -math.sin(angle), 0.0])


def palm_pose(angle, sway=(0.0, 0.0)):
    """Palm link pose (origin, rotation) with its knuckles ``angle`` round the staircase, shifted by ``sway`` (forward, left)."""
    forward, left = heading(angle)
    eps = 1e-3
    pitch = math.atan((slope_height(angle + eps) - slope_height(angle - eps)) / (2 * eps * WALK_RADIUS)) - NOSE_DOWN
    nose = math.cos(pitch) * forward + math.sin(pitch) * np.array([0.0, 0.0, 1.0])
    R = np.column_stack([-np.cross(nose, left), left, nose])
    knuckles = WALK_RADIUS * np.array([math.cos(angle), math.sin(angle), 0.0]) + sway[0] * forward + sway[1] * left
    knuckles[2] = slope_height(angle) + KNUCKLE_HEIGHT
    return knuckles - R @ KNUCKLES, R


class Gait:
    """Footholds and swing times of the five fingers, as functions of the palm's angle in treads."""

    def __init__(self, hand):
        from scipy.optimize import linear_sum_assignment

        self.hand = hand
        self.slots = sum(foot["steps"] for foot in FEET)
        self.swing = SWING / self.slots
        self.unload = UNLOAD / self.slots
        self.radius = [WALK_RADIUS - foot["left"] for foot in FEET]
        bounds, wanted = [], []
        for foot, radius in zip(FEET, self.radius):
            run, n = radius * TREAD_ANGLE, foot["steps"]
            lo, hi = foot["nose"] / run, 1 / n - foot["riser"] / run
            if hi < lo:
                raise ValueError(f"{n} footholds do not fit a {run * 100:.1f} cm tread")
            bounds.append((lo, hi))
            # Swing j leaves foothold j of a tread; it is due when the foot's mid-stance spot passes halfway to the next.
            wanted.append([(j + 0.5) / n - foot["lead"] / run for j in range(n)])
        # first[f]: where on its tread, as a fraction, the first foothold of finger f sits.
        self.first = [(lo + hi) / 2 for lo, hi in bounds]
        swings = [(f, j) for f, foot in enumerate(FEET) for j in range(foot["steps"])]
        centers = (np.arange(self.slots) + 0.5) / self.slots
        for _ in range(3):
            due = np.array([self.first[f] + wanted[f][j] for f, j in swings])
            late = (centers[None, :] - due[:, None] + 0.5) % 1 - 0.5
            _, slot = linear_sum_assignment(np.abs(late))
            # Slide each finger's footholds along the tread, inside their clearances, toward the slots its swings got.
            for f in range(5):
                mean = np.mean([late[k, slot[k]] for k, (g, _) in enumerate(swings) if g == f])
                self.first[f] = min(max(self.first[f] + float(mean), bounds[f][0]), bounds[f][1])
        due = [self.first[f] + wanted[f][j] for f, j in swings]
        # start[f][j]: palm angle, in treads, at which finger f leaves foothold j of tread 0.
        self.start = [[0.0] * foot["steps"] for foot in FEET]
        for k, (f, j) in enumerate(swings):
            center = centers[slot[k]]
            self.start[f][j] = center + round(due[k] - center) - self.swing / 2
        for f in range(5):
            times = self.start[f] + [self.start[f][0] + 1]
            if any(b - a < self.swing + 2 * self.unload for a, b in zip(times, times[1:])):
                raise ValueError(f"{NAMES[f]}: swings out of order {times}")

    def foothold(self, f, g):
        n = FEET[f]["steps"]
        angle = (g // n + self.first[f] + (g % n) / n) * TREAD_ANGLE
        r = self.radius[f]
        return np.array([r * math.cos(angle), r * math.sin(angle), ground_height(r, angle) + self.hand.fingers[f]["radius"]])

    def swing_start(self, f, g):
        n = FEET[f]["steps"]
        return self.start[f][g % n] + g // n

    def latest(self, f, u):
        """The last swing finger ``f`` began at or before palm angle ``u`` treads."""
        n = FEET[f]["steps"]
        return max(math.floor(u - self.start[f][j]) * n + j for j in range(n))

    def load(self, f, angle):
        """Whether finger ``f`` bears weight: 0 in swing, ramping to 1 over the unload time either side."""
        u = angle / TREAD_ANGLE
        g = self.latest(f, u)
        landed = self.swing_start(f, g) + self.swing
        if u < landed:
            return 0.0
        return min(1.0, (u - landed) / self.unload, (self.swing_start(f, g + 1) - u) / self.unload)

    def foot(self, f, angle):
        """World position of the tip center of finger ``f``."""
        u = angle / TREAD_ANGLE
        g = self.latest(f, u)
        w = (u - self.swing_start(f, g)) / self.swing
        if w >= 1:
            return self.foothold(f, g + 1)
        a, b = self.foothold(f, g), self.foothold(f, g + 1)
        # Up first, across by two thirds of the swing, then straight down: a drive that trails its target still lands on the spot.
        travel = smoothstep((w - 0.12) / 0.55)
        r = self.radius[f]
        ang_a, ang_b = math.atan2(a[1], a[0]), math.atan2(b[1], b[0])
        ang = ang_a + travel * ((ang_b - ang_a + math.pi) % (2 * math.pi) - math.pi)
        rise = smoothstep(w / 0.4) if b[2] >= a[2] else smoothstep((w - 0.6) / 0.4)
        z = a[2] + (b[2] - a[2]) * rise + SWING_CLEARANCE * smoothstep(w / 0.2) * (1 - smoothstep((w - 0.67) / 0.33))
        return np.array([r * math.cos(ang), r * math.sin(ang), z])

    def rest(self, angle):
        """The palm angle nearest ``angle`` at which every finger is planted."""
        return round(angle / TREAD_ANGLE * self.slots) / self.slots * TREAD_ANGLE


def inside_margin(polygon, point):
    """Distance from ``point`` to the edge of the convex hull of ``polygon`` (negative outside), and the direction that raises it."""
    from scipy.spatial import ConvexHull

    hull = ConvexHull(polygon)
    worst, push = math.inf, np.zeros(2)
    for eq in hull.equations:
        d = -(eq[:2] @ point + eq[2])
        if d < worst:
            worst, push = d, -eq[:2]
    return worst, push


def stair_height(pose, angle, point):
    """Height of ``point`` (palm coordinates) over the stairs less a link's radius, and the upward direction in palm coordinates."""
    origin, R = pose
    p = origin + R @ point
    along = angle + (math.atan2(p[1], p[0]) - angle + math.pi) % (2 * math.pi) - math.pi
    return p[2] - ground_height(math.hypot(p[0], p[1]), along) - LINK_RADIUS, R[2]


def stance_posture(hand, f, probes):
    """A posture of finger ``f`` from which it reaches all its stance spots with its joints clear of the stairs.

    ``probes`` are (target in palm coordinates, palm pose, palm angle) along the walk.
    """
    F = hand.fingers[f]
    middle, pose, _ = probes[len(probes) // 2]
    down = -pose[1][2]
    candidates = []
    for q in np.random.default_rng(f).uniform(F["lower"], F["upper"], size=(6000, 4)):
        frames, tip = hand.fk(f, q)
        cost = np.linalg.norm(tip - middle)
        cost += 0.05 * max(0.0, 0.3 - frames[3][1][:, 2] @ down)
        cost += sum(max(0.0, (p - tip) @ down + 0.008) for p, _ in frames[1:])
        candidates.append((cost, tuple(q)))
    best, best_score = None, math.inf
    for _, seed in sorted(candidates)[:10]:
        first, _ = hand.ik(f, middle, seed, np.array(seed), iterations=80)
        q, score = first, 0.0
        for target, pose, angle in probes:
            q, miss = hand.ik(f, target, q, first, iterations=25, clearance=lambda point: stair_height(pose, angle, point))
            score = max(score, miss - 0.3 * min(link_clearance(hand, f, q, pose, angle), LINK_CLEARANCE))
        if score < best_score:
            best, best_score = first, score
    return best


def link_clearance(hand, f, q, pose, angle):
    """Least height of the links of finger ``f`` over the stairs, the fingertip pad aside."""
    origin, R = pose
    frames, tip = hand.fk(f, q)
    points = [origin + R @ p for p, _ in frames] + [origin + R @ tip]
    least = math.inf
    for k, (a, b) in enumerate(zip(points, points[1:])):
        last = k == len(points) - 2
        for t in np.linspace(0.0, 0.6 if last else 1.0, 6):
            p = a + t * (b - a)
            along = angle + (math.atan2(p[1], p[0]) - angle + math.pi) % (2 * math.pi) - math.pi
            least = min(least, p[2] - ground_height(math.hypot(p[0], p[1]), along) - LINK_RADIUS)
    return least


def plan(hand, verbose=True):
    """The walk per 60 Hz frame: palm poses, fingertip spots, joint angles and which fingers bear weight."""
    gait = Gait(hand)
    # Palm angle over time: rest, ramp up to the cruise rate, ramp down, rest.
    rate = TREAD_ANGLE / TREAD_SECONDS
    begin, end = gait.rest(START_ANGLE), gait.rest(END_ANGLE)
    cruise = (end - begin) / rate - RAMP_SECONDS
    if cruise < 0:
        raise ValueError("the walk is shorter than its two ramps")
    n = round((SETTLE_SECONDS + cruise + 2 * RAMP_SECONDS + HOLD_SECONDS) * FPS) + 1
    angles = np.zeros(n)
    for i in range(n):
        s = i / FPS - SETTLE_SECONDS
        if s <= 0:
            travelled = 0.0
        elif s < RAMP_SECONDS:
            x = s / RAMP_SECONDS
            travelled = rate * RAMP_SECONDS * (x ** 3 - x ** 4 / 2)
        elif s < RAMP_SECONDS + cruise:
            travelled = rate * (s - RAMP_SECONDS / 2)
        elif s < 2 * RAMP_SECONDS + cruise:
            x = (2 * RAMP_SECONDS + cruise - s) / RAMP_SECONDS
            travelled = rate * (cruise + RAMP_SECONDS) - rate * RAMP_SECONDS * (x ** 3 - x ** 4 / 2)
        else:
            travelled = rate * (cruise + RAMP_SECONDS)
        angles[i] = begin + travelled

    feet = np.array([[gait.foot(f, a) for f in range(5)] for a in angles])
    loads = np.array([[gait.load(f, a) for f in range(5)] for a in angles])
    if loads[0].min() < 1 or loads[-1].min() < 1:
        raise ValueError("a finger is in the air at the start or the end")
    sway = np.zeros((n, 2))

    # Postures the inverse kinematics leans toward: one per finger that reaches every spot it stands on.
    posture = []
    for f in range(5):
        stance = [i for i in range(n) if loads[i, f] >= 1]
        probes = []
        for i in stance[:: max(1, len(stance) // 50)]:
            origin, R = palm_pose(angles[i])
            probes.append((R.T @ (feet[i, f] - origin), (origin, R), angles[i]))
        posture.append(stance_posture(hand, f, probes))

    def solve(sway):
        qs, miss, coms, poses = np.zeros((n, 5, 4)), np.zeros((n, 5)), np.zeros((n, 3)), []
        q = [p.copy() for p in posture]
        for i, a in enumerate(angles):
            origin, R = palm_pose(a, sway[i])
            for f in range(5):
                q[f], miss[i, f] = hand.ik(f, R.T @ (feet[i, f] - origin), q[f], posture[f], iterations=60 if i == 0 else 8,
                                           clearance=lambda point: stair_height((origin, R), a, point))
                qs[i, f] = q[f]
            coms[i] = origin + R @ hand.center_of_mass(qs[i])
            poses.append((origin, R))
        return qs, miss, coms, poses

    def margins(coms):
        out, pushes = np.zeros(n), np.zeros((n, 2))
        for i in range(n):
            planted = [f for f in range(5) if loads[i, f] >= 1]
            out[i], pushes[i] = inside_margin(feet[i, planted, :2], coms[i, :2])
        return out, pushes

    # Lean the palm until the center of mass keeps SUPPORT_MARGIN inside the planted feet, then smooth the lean.
    kernel = np.hanning(2 * round(0.6 * TREAD_SECONDS / gait.slots * FPS) + 1)
    kernel /= kernel.sum()
    for _ in range(LEAN_PASSES):
        qs, miss, coms, poses = solve(sway)
        margin, pushes = margins(coms)
        if verbose:
            print(f"  lean pass: support margin min {margin.min() * 1000:.1f} mm, lean max {np.abs(sway).max() * 1000:.1f} mm")
        short = margin < SUPPORT_MARGIN
        world = np.zeros((n, 2))
        world[short] = pushes[short] * (SUPPORT_MARGIN - margin[short])[:, None] * 1.3
        for i in range(n):
            forward, left = heading(angles[i])
            sway[i] += [world[i] @ forward[:2], world[i] @ left[:2]]
        padded = np.pad(sway, ((len(kernel) // 2,) * 2, (0, 0)), mode="edge")
        sway = np.column_stack([np.convolve(padded[:, k], kernel, mode="valid") for k in range(2)])
    qs, miss, coms, poses = solve(sway)
    margin, _ = margins(coms)

    if verbose:
        print(f"swing starts [treads]: " + ", ".join(f"{NAMES[f]} {np.round(gait.start[f], 3)}" for f in range(5)))
        for f in range(5):
            F = hand.fingers[f]
            lead = np.zeros(n)
            for i in range(n):
                origin, R = poses[i]
                forward, _ = heading(angles[i])
                lead[i] = (feet[i, f] - (origin + R @ KNUCKLES)) @ forward
            stance = loads[:, f] > 0
            near = np.minimum(qs[:, f] - F["lower"], F["upper"] - qs[:, f]).min(axis=0)
            gap = min(link_clearance(hand, f, qs[i, f], poses[i], angles[i]) for i in range(0, n, 2))
            print(f"{NAMES[f]:7s} radius {gait.radius[f]:.3f} first foothold {gait.first[f]:.3f} tread, stance lead {lead[stance].min() * 100:+.1f}..{lead[stance].max() * 100:+.1f} cm, "
                  f"ik miss max {miss[:, f].max() * 1000:.2f} mm (stance {miss[stance, f].max() * 1000:.2f}), limit slack {np.round(near, 2)}, links clear the stairs by {gap * 1000:.1f} mm")
        acc = np.diff(sway, 2, axis=0) * FPS * FPS
        print(f"frames {n} ({n / FPS:.1f} s), support margin min {margin.min() * 1000:.1f} mm, lean max {np.abs(sway).max(axis=0) * 1000} mm, "
              f"lean accel max {np.abs(acc).max():.2f} m/s^2, mass {hand.mass:.3f} kg")
    return {"q": qs, "poses": poses, "angles": angles, "feet": feet, "loads": loads, "coms": coms, "margin": margin, "miss": miss, "sway": sway,
            "posture": posture, "gait": gait}


class Walker:
    """Turns the plan into joint targets frame by frame, aiming each step from where the palm really is.

    Walked blind, the hand lands every step a fraction of a millimeter off and the errors add up until a
    fingertip meets a riser. Told the palm's pose, a swinging finger is aimed at its foothold from there, and
    once planted it is drawn over STEP_FADE_SECONDS to where the plan has it, which pulls the palm back on course.
    """

    def __init__(self, hand, motion):
        self.hand, self.motion = hand, motion
        self.q = [p.copy() for p in motion["posture"]]
        self.before = None
        self.drift = np.zeros(3)  # knuckle x, y and heading, actual less planned, low-passed
        self.shift = np.zeros((5, 2))  # where a finger is told to be, less where the plan has it
        self.lifted = np.zeros((5, 2))
        self.landed = [0] * 5
        self.worst = np.zeros(3)

    def targets(self, i, palm=None):
        """Joint targets (5 x 4) for frame ``i``; ``palm`` is the palm's center of mass and quaternion before it."""
        hand, m = self.hand, self.motion
        origin, R = m["poses"][i]
        angle = m["angles"][i]
        knuckles = origin + R @ KNUCKLES
        if palm is not None:
            Ra = quat_to_mat(palm[3:])
            actual = np.array(palm[:3]) + Ra @ (KNUCKLES - np.array(hand.scene["bodies"]["com"][hand.palm]))
            turn = math.atan2(Ra[1, 2], Ra[0, 2]) - math.atan2(R[1, 2], R[0, 2])
            off = np.array([actual[0] - knuckles[0], actual[1] - knuckles[1], (turn + math.pi) % (2 * math.pi) - math.pi])
            self.drift += DRIFT_FILTER * (off - self.drift)
            self.worst = np.maximum(self.worst, np.abs(off))
        c, s = math.cos(self.drift[2]), math.sin(self.drift[2])
        q = np.zeros((5, 4))
        for f in range(5):
            spot = m["feet"][i, f]
            if m["loads"][i, f] > 0:
                shift = self.shift[f] * (1 - smoothstep((i - self.landed[f]) / (STEP_FADE_SECONDS * FPS)))
                self.lifted[f] = shift
            else:
                # The spot seen from the drifted palm, as the plan's palm must be told it.
                d = spot[:2] - knuckles[:2] - self.drift[:2]
                aim = knuckles[:2] + [c * d[0] + s * d[1], -s * d[0] + c * d[1]] - spot[:2]
                u = angle / TREAD_ANGLE
                w = (u - m["gait"].swing_start(f, m["gait"].latest(f, u))) / m["gait"].swing
                across = smoothstep((w - 0.12) / 0.55)
                shift = self.shift[f] = (1 - across) * self.lifted[f] + across * aim
                self.landed[f] = i
            told = spot + [shift[0], shift[1], 0.0]
            self.q[f], _ = hand.ik(f, R.T @ (told - origin), self.q[f], m["posture"][f], iterations=60 if i == 0 else 8,
                                   clearance=lambda point: stair_height((origin, R), angle, point))
            q[f] = self.q[f]

        # A planted finger's drives lead their angle by part of the torque of its share of the weight over their stiffness.
        targets = q.copy()
        feet, com = m["feet"][i], m["coms"][i]
        A = np.vstack([np.ones(5), feet[:, 0], feet[:, 1]])
        W = np.diag(m["loads"][i])
        force = np.clip(W @ A.T @ np.linalg.solve(A @ W @ A.T + 1e-9 * np.eye(3), hand.mass * GRAVITY * np.array([1.0, com[0], com[1]])), 0.0, None)
        for f in range(5):
            F = hand.fingers[f]
            frames, tip = hand.fk(f, q[f])
            torque = -hand.jacobian(frames, tip).T @ (R.T @ np.array([0.0, 0.0, force[f]]))
            targets[f] += LOAD_LEAD * torque / (STIFFNESS * F["ke"])
            # The drives damp joint speed itself, not its error, so a moving joint trails its target; the target runs ahead.
            if self.before is not None:
                targets[f] += SPEED_LEAD * (q[f] - self.before[f]) * FPS * (DAMPING * F["kd"]) / (STIFFNESS * F["ke"])
        self.before = q
        return targets


def serve(hand, motion, port):
    """Joint targets per frame from a simulation stepped against the walker over HTTP (apps/viewer/scripts/drive.ts)."""
    from http.server import BaseHTTPRequestHandler, HTTPServer

    walker = Walker(hand, motion)
    n = len(motion["angles"])
    sent = np.zeros((n, 20), dtype=np.float32)
    state = {"next": 0}

    class Handler(BaseHTTPRequestHandler):
        def reply(self, body):
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.reply({})

        def do_GET(self):
            # dof: the Newton dof of the first finger joint, after the palm's six.
            self.reply({"scene": NAME, "frames": n, "dof": 6})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            i = body["frame"]
            if i != state["next"]:
                self.send_error(409, f"expected frame {state['next']}")
                return
            sent[i] = walker.targets(i, body["palm"]).reshape(20)
            state["next"] = i + 1
            self.reply({"targets": sent[i].tolist()})

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"walker on http://127.0.0.1:{port}: step the scene against it with apps/viewer/scripts/drive.ts")
    while state["next"] < n:
        server.handle_request()
    server.server_close()
    print(f"palm drift at most {walker.worst[0] * 1000:.1f} mm, {walker.worst[1] * 1000:.1f} mm and {math.degrees(walker.worst[2]):.1f} deg")
    return sent


class Blob:
    def __init__(self):
        self.data = bytearray()

    def put(self, values, dtype):
        a = np.ascontiguousarray(values, dtype=dtype)
        while len(self.data) % 4:
            self.data.append(0)
        off = len(self.data)
        self.data += a.tobytes()
        return {"off": off, "n": int(a.size)}


def prism(outline, z0, z1):
    """Hull of a convex outline (counterclockwise from above) extruded from ``z0`` to ``z1``: vertices and faces."""
    k = len(outline)
    verts = [[x, y, z0] for x, y in outline] + [[x, y, z1] for x, y in outline]
    faces = [list(range(k - 1, -1, -1)), list(range(k, 2 * k))]
    faces += [[i, (i + 1) % k, (i + 1) % k + k, i + k] for i in range(k)]
    return np.array(verts), faces


def hull_record(blob, verts, faces):
    planes, start, flat = [], [0], []
    for face in faces:
        a, b, c = verts[face[0]], verts[face[1]], verts[face[2]]
        normal = np.cross(b - a, c - a)
        normal /= np.linalg.norm(normal)
        planes += [*normal, float(normal @ a)]
        flat += face
        start.append(len(flat))
    return {
        "verts": blob.put(verts, np.float32),
        "face_planes": blob.put(planes, np.float32),
        "face_start": blob.put(start, np.uint32),
        "face_verts": blob.put(flat, np.uint32),
        "nv": len(verts),
        "nf": len(faces),
    }


def sector(angle, step=math.radians(7.5)):
    """Outline of a tread: the chord at the inner radius, then the outer arc."""
    count = max(1, round(angle / step))
    arc = [(TREAD_OUTER * math.cos(angle * i / count), TREAD_OUTER * math.sin(angle * i / count)) for i in range(count + 1)]
    return [(TREAD_INNER, 0.0), *arc, (TREAD_INNER * math.cos(angle), TREAD_INNER * math.sin(angle))]


def lathe(profile, segments=48):
    """Triangle mesh of a (radius, height) profile turned round the z axis, outward when the profile climbs."""
    verts, tris = [], []
    for r, z in profile:
        verts += [[r * math.cos(2 * math.pi * s / segments), r * math.sin(2 * math.pi * s / segments), z] for s in range(segments)]
    for ring in range(len(profile) - 1):
        for s in range(segments):
            a, b = ring * segments + s, ring * segments + (s + 1) % segments
            tris.append([a, b, b + segments])
            if profile[ring + 1][0] > 0:
                tris.append([a, b + segments, a + segments])
    return np.array(verts), np.array(tris)


def export(hand, motion, joint_targets, out):
    src = hand.scene
    B, J = src["bodies"], src["joints"]
    blob = Blob()
    body_of = {b: i for i, b in enumerate(hand.bodies)}
    origin, R = motion["poses"][0]
    q0 = motion["q"][0]

    body_q = [[*origin, *mat_to_quat(R)]]
    for f in range(5):
        for p, Rl in hand.fk(f, q0[f])[0]:
            body_q.append([*(origin + R @ p), *mat_to_quat(R @ Rl)])
    bodies = {
        "count": len(hand.bodies),
        "mass": [B["mass"][b] for b in hand.bodies],
        "inertia": [B["inertia"][b] for b in hand.bodies],
        "com": [B["com"][b] for b in hand.bodies],
        "q": body_q,
        "twist": [[0.0] * 6 for _ in hand.bodies],
        "label": [B["label"][b] for b in hand.bodies],
        "kinematic": [False] * len(hand.bodies),
        "no_gravity": [False] * len(hand.bodies),
    }

    # The palm's fixed base becomes a free joint; the 20 finger joints keep their drives and limits.
    chain = [j for f in hand.fingers for j in f["joints"]]
    dofs = [J["qd_start"][j] for j in chain]
    identity = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    free = {"armature": 0.0, "effort": 1e6, "lower": -1e10, "upper": 1e10, "vel_limit": 1e6, "friction": 0.0,
            "spring_stiffness": 0.0, "spring_ref": 0.0, "passive_damping": 0.0, "target_qd": 0.0, "target_mode": 0}
    joint_q = [*body_q[0], *(float(v) for v in q0.reshape(-1))]
    joints = {
        "count": 21,
        "type": [4] + [1] * 20,
        "parent": [-1] + [body_of[J["parent"][j]] for j in chain],
        "child": [0] + [body_of[J["child"][j]] for j in chain],
        "X_p": [identity] + [J["X_p"][j] for j in chain],
        "X_c": [identity] + [J["X_c"][j] for j in chain],
        "axis": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] * 2 + [J["axis"][d] for d in dofs],
        "dof_dim": [[3, 3]] + [[0, 1]] * 20,
        "mimic_joint": [-1] * 21,
        "mimic_coeffs": [[0.0, 1.0]] * 21,
        "q_start": [0] + list(range(7, 28)),
        "qd_start": [0] + list(range(6, 27)),
        "articulation": [0] * 21,
        "q": joint_q,
        **{key: [value] * 6 + [J[key][d] for d in dofs] for key, value in free.items()},
        "ke": [0.0] * 6 + [STIFFNESS * J["ke"][d] for d in dofs],
        "kd": [0.0] * 6 + [DAMPING * J["kd"][d] for d in dofs],
        "damping": [0.0] * 6 + [DAMPING * J["kd"][d] for d in dofs],
        "friction_load_coefficient": [],
        "target_q": joint_q,
        "articulation_start": [0, 21],
        "label": ["free_base"] + [J["label"][j] for j in chain],
    }

    convex = src["geo_type_names"]["CONVEX_MESH"]
    hulls = {}
    shapes = []
    for s in src["shapes"]:
        if s.get("body") not in body_of:
            continue
        key = s["hull"]["verts"]["off"]
        if key not in hulls:
            h = s["hull"]
            hulls[key] = {
                "verts": blob.put(np.frombuffer(hand.blob, np.float32, h["verts"]["n"], h["verts"]["off"]), np.float32),
                "face_planes": blob.put(np.frombuffer(hand.blob, np.float32, h["face_planes"]["n"], h["face_planes"]["off"]), np.float32),
                "face_start": blob.put(np.frombuffer(hand.blob, np.uint32, h["face_start"]["n"], h["face_start"]["off"]), np.uint32),
                "face_verts": blob.put(np.frombuffer(hand.blob, np.uint32, h["face_verts"]["n"], h["face_verts"]["off"]), np.uint32),
                "nv": h["nv"],
                "nf": h["nf"],
            }
        # The hand's hulls go in as convex meshes: mesh-typed ones make no contact with the ground plane.
        shapes.append({**s, "sid": len(shapes), "body": body_of[s["body"]], "hull": hulls[key], "type": convex})
    material = {k: shapes[0][k] for k in ("mu", "gap", "restitution", "mu_torsional", "mu_rolling", "group", "condim", "ke", "kd", "torsion_radius", "world")}
    filters = [[a, b] for a in range(len(shapes)) for b in range(a + 1, len(shapes))]

    visuals, seen = [], set()
    for v in src["visuals"]:
        key = (v["body"], v["mesh"]["file"], tuple(v["xf"]))
        if v["body"] in body_of and key not in seen:
            seen.add(key)
            visuals.append({**v, "body": body_of[v["body"]]})

    woods, steel = ([0.80, 0.62, 0.41], [0.71, 0.53, 0.34]), [0.23, 0.25, 0.29]

    def static(hull, xf, color, visible=True):
        shapes.append({"sid": len(shapes), "body": -1, "xf": xf, "type": convex, "color": color, "hull": hull, "visible": visible, **material})

    tread = hull_record(blob, *prism(sector(TREAD_ANGLE), 0.0, RISE))
    for k in range(TREADS):
        static(tread, [0.0, 0.0, k * RISE, *mat_to_quat(rot_z(k * TREAD_ANGLE))], woods[k % 2])
    landing = hull_record(blob, *prism(sector(LANDING_ANGLE), 0.0, RISE))
    static(landing, [0.0, 0.0, TREADS * RISE, *mat_to_quat(rot_z(TREADS * TREAD_ANGLE))], woods[TREADS % 2])
    top = (TREADS + 1) * RISE + 0.11
    ring = [(COLUMN_RADIUS * math.cos(2 * math.pi * s / 16), COLUMN_RADIUS * math.sin(2 * math.pi * s / 16)) for s in range(16)]
    static(hull_record(blob, *prism(ring, 0.0, top)), identity, steel, visible=False)
    # The column is drawn round, with a ball on top; it collides as a 16-sided prism.
    ball = 1.3 * COLUMN_RADIUS
    waist = math.asin(COLUMN_RADIUS / ball)
    cap = [(ball * math.sin(a), top + ball * (math.cos(waist) - math.cos(a))) for a in np.linspace(waist, math.pi, 14)]
    v, i = lathe([(COLUMN_RADIUS, 0.0), *cap[:-1], (0.0, cap[-1][1])])
    visuals.append({"body": -1, "xf": identity, "color": steel, "mesh": {"v": blob.put(v, np.float32), "i": blob.put(i, np.uint32), "crease": True}})
    plane = next(s for s in src["shapes"] if s.get("plane"))
    shapes.append({**plane, "sid": len(shapes), "xf": identity, "color": [0.78, 0.79, 0.78]})

    targets = np.zeros((len(joint_targets), 26), dtype=np.float32)
    targets[:, 6:] = joint_targets
    scene = {
        "gravity": [0.0, 0.0, -GRAVITY],
        "fps": FPS,
        "substeps": src["solver"]["substeps"],
        "iterations": src["solver"]["iterations"],
        "bodies": bodies,
        "joints": joints,
        "shapes": shapes,
        "visuals": visuals,
        "filters": filters,
        "mimics": [],
        "targets": blob.put(targets, np.float32),
        "target_frames": len(targets),
        "driven": 26,
        "targets_held": False,
        # The hand is one driven articulation, which the mouse spring leaves alone unless asked.
        "mouse_drag": "all",
        "integral_count": 0,
        "demo": NAME,
        "control": None,
        "solver": src["solver"],
        "info": {
            "about": "A 20-joint Wuji hand with no arm behind it walks up a spiral staircase on its fingertips. One finger steps at a time "
                     "while the palm leans over the four left standing.",
            "camera": {"eye": [-0.10, 0.86, 0.60], "target": [0.0, -0.02, 0.05]},
            "tracked_body": 0,
        },
        "joint_type_names": src["joint_type_names"],
        "geo_type_names": src["geo_type_names"],
    }
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "scene.json").write_text(json.dumps(scene))
    (out / "scene.bin").write_bytes(bytes(blob.data))
    print(f"bodies {bodies['count']} shapes {len(shapes)} visuals {len(visuals)} frames {len(targets)} bin {len(blob.data) / 1e6:.2f} MB -> {out}")


def main(scenes, port):
    scenes = Path(scenes)
    scene = json.loads((scenes / SOURCE / "scene.json").read_text())
    hand = Hand(scene, (scenes / SOURCE / "scene.bin").read_bytes())
    motion = plan(hand)
    # The scene goes out walked blind first, for the browser to load; then again with the targets the walker sent.
    walker = Walker(hand, motion)
    blind = np.array([walker.targets(i).reshape(20) for i in range(len(motion["angles"]))], dtype=np.float32)
    export(hand, motion, blind, scenes / NAME)
    if port:
        export(hand, motion, serve(hand, motion, port), scenes / NAME)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("scenes", nargs="?", default=ROOT / "assets" / "scenes", help="folder of exported scenes")
    parser.add_argument("--port", type=int, default=8791, help="port the walker serves on; 0 to leave the walk blind")
    args = parser.parse_args()
    main(args.scenes, args.port)
