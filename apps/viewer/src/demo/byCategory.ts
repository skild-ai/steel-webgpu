import type { SceneEntry } from '@skild-ai/steel-webgpu';

/** Scenes grouped by category for the picker and the gallery, both in index order. */
export function byCategory(scenes: SceneEntry[]): [string, SceneEntry[]][] {
  const groups = new Map<string, SceneEntry[]>();
  for (const s of scenes) {
    const category = s.category ?? 'Scenes';
    groups.set(category, [...(groups.get(category) ?? []), s]);
  }
  return [...groups];
}
