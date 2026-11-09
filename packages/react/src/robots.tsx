import { useContext, useEffect, useEffectEvent, useImperativeHandle, useMemo, type Ref } from 'react';
import { loadMJCF, loadURDF, type LoadedRobot, type RobotOptions, type SceneBuilder, type Transform } from '@skild-ai/steel-webgpu';
import { BuildContext, useWorld } from './context';

export interface RobotHandle {
  /** Body index per link (URDF) or body (MJCF) name, once built. */
  readonly bodies: ReadonlyMap<string, number>;
  /** First Newton dof per joint name, once built. */
  readonly dofs: ReadonlyMap<string, number>;
  /** Drives a named joint's first dof toward a position (and velocity), held until changed. */
  setJointTarget(joint: string, position: number, velocity?: number): void;
  setJointForce(joint: string, value: number): void;
}

interface RobotProps {
  /** URL of the robot file; meshes resolve against its folder unless `baseUrl` is given. */
  src: string;
  baseUrl?: string;
  xform?: Transform;
  material?: RobotOptions['material'];
  ref?: Ref<RobotHandle>;
}

type Loader = (builder: SceneBuilder, text: string, baseUrl: string) => Promise<LoadedRobot>;

const folderOf = (url: string) => url.slice(0, url.lastIndexOf('/') + 1);

function useRobot(component: string, load: Loader, { src, baseUrl, ref }: RobotProps, key: string) {
  const registry = useContext(BuildContext);
  if (!registry) throw new Error(`<${component}> must be inside a <Scene> without src`);
  const built = useMemo(() => ({ bodies: new Map<string, number>(), dofs: new Map<string, number>() }), []);
  const loadRobot = useEffectEvent(load);
  useEffect(() => {
    const loaded: { robot?: LoadedRobot } = {};
    return registry.register({
      phase: 0,
      async run(builder) {
        const text = await fetch(src).then((r) => r.text());
        loaded.robot = await loadRobot(builder, text, baseUrl ?? folderOf(src));
      },
      after(builder) {
        const { robot } = loaded;
        if (!robot) return;
        built.bodies.clear();
        built.dofs.clear();
        for (const [name, body] of robot.bodies) built.bodies.set(name, body);
        for (const [name, joint] of robot.joints) built.dofs.set(name, robot.dofs?.get(name) ?? builder.jointDof(joint));
      },
    });
  }, [registry, src, baseUrl, key, built]);
  const world = useWorld();
  useImperativeHandle(ref, () => {
    const dof = (joint: string) => {
      const d = built.dofs.get(joint);
      if (d === undefined) throw new Error(`<${component} src="${src}">: no joint named ${joint}`);
      return d;
    };
    return {
      bodies: built.bodies,
      dofs: built.dofs,
      setJointTarget: (joint, position, velocity = 0) => world?.sim.setJointTarget(dof(joint), position, velocity),
      setJointForce: (joint, value) => world?.sim.setJointForce(dof(joint), value),
    };
  }, [world, built, src, component]);
  return null;
}

export interface URDFProps extends RobotProps {
  /** A floating base instead of one fixed to the world at `xform`. */
  floating?: boolean;
  density?: number;
  /** package:// prefixes mapped to URLs. */
  packages?: Record<string, string>;
}

export function URDF(props: URDFProps) {
  const { xform, material, floating, density, packages } = props;
  return useRobot(
    'URDF',
    (builder, text, baseUrl) => loadURDF(builder, text, { baseUrl, xform, material, floating, density, packages }),
    props,
    JSON.stringify([xform, material, floating, density, packages]),
  );
}

export function MJCF(props: RobotProps) {
  const { xform, material } = props;
  return useRobot('MJCF', (builder, text, baseUrl) => loadMJCF(builder, text, { baseUrl, xform, material }), props, JSON.stringify([xform, material]));
}
