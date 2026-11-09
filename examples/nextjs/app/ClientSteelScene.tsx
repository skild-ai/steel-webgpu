'use client';

import dynamic from 'next/dynamic';

// WebGPU and the R3F canvas only exist in the browser, so the scene is never rendered on the server.
export const ClientSteelScene = dynamic(() => import('./SteelScene').then((m) => m.SteelScene), { ssr: false });
