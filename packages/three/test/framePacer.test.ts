import { describe, expect, test } from 'vite-plus/test';
import { FramePacer } from '../src/framePacer';

describe('FramePacer', () => {
  test('runs one frame per elapsed 1/fps and at most two per tick', () => {
    const pacer = new FramePacer(60, 0);
    expect(pacer.framesDue(17, true)).toBe(1);
    expect(pacer.framesDue(67, true)).toBe(2);
  });

  test('keeps at most two frames in flight on the GPU', () => {
    const pacer = new FramePacer(60, 0);
    pacer.started();
    pacer.started();
    expect(pacer.framesDue(40, true)).toBe(0);
    pacer.finished();
    expect(pacer.framesDue(80, true)).toBe(1);
  });

  test('drops the debt after a stall instead of catching up', () => {
    const pacer = new FramePacer(60, 0);
    expect(pacer.framesDue(1000, true)).toBe(2);
    expect(pacer.framesDue(1001, true)).toBe(0);
  });

  test('runs nothing while paused and resumes without a burst', () => {
    const pacer = new FramePacer(60, 0);
    expect(pacer.framesDue(500, false)).toBe(0);
    expect(pacer.framesDue(517, true)).toBe(1);
  });
});
