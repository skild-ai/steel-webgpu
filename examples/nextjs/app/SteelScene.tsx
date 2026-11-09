'use client';

import { Physics, Scene } from '@skild-ai/steel-webgpu/react';
import type { CSSProperties } from 'react';

const message: CSSProperties = { display: 'grid', placeItems: 'center', height: '100%', margin: 0, padding: 24, textAlign: 'center' };

export function SteelScene() {
  return (
    <Physics
      style={{ width: '100%', height: '100%' }}
      fallback={<p style={message}>Requesting a WebGPU device...</p>}
      unsupported={(reason) => <p style={message}>This browser cannot run steel-webgpu: {reason}</p>}
    >
      <Scene src="/assets/bolt_sweep" />
    </Physics>
  );
}
