---
'@skild-ai/steel-webgpu': patch
---

MJCF actuators' `forcerange` now limits the joint drive's torque (`effortLimit`), as MuJoCo clamps actuator force (`forcelimited`, or `autolimits` when a range is given).
