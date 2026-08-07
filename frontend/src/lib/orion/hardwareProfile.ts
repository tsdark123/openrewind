// =============================================================================
// hardwareProfile.ts — read-only frontend types and wrapper for the Tauri
// hardware probe command.  No selection, no startup side effects, no telemetry.
// =============================================================================

import { isTauri } from './client';

export type ProbeStatus = 'known' | 'unknown' | 'unsupported' | 'error';
export type Confidence = 'high' | 'medium' | 'low';

export interface ProbeValue<T> {
  status: ProbeStatus;
  value?: T;
  source: string;
  confidence?: Confidence;
  note?: string;
}

export interface CpuProfile {
  logicalCores: ProbeValue<number>;
  physicalCores: ProbeValue<number>;
  brand: ProbeValue<string>;
}

export interface RamProfile {
  totalMib: ProbeValue<number>;
  availableMib: ProbeValue<number>;
}

export interface GpuDeviceProfile {
  index: number;
  model: ProbeValue<string>;
  totalVramMib: ProbeValue<number>;
  availableVramMib: ProbeValue<number>;
  computeCapability: ProbeValue<string>;
}

export interface GpuInventory {
  status: ProbeStatus;
  source: string;
  note?: string;
  devices: GpuDeviceProfile[];
}

export interface HardwareProfile {
  platform: string;
  timestamp: string;
  cpu: CpuProfile;
  ram: RamProfile;
  gpuInventory: GpuInventory;
  warnings: string[];
}

function browserUnsupportedProfile(): HardwareProfile {
  return {
    platform: 'browser',
    timestamp: new Date().toISOString(),
    cpu: {
      logicalCores: { status: 'unsupported', source: 'browser', note: 'Hardware probe is not available in the browser.' },
      physicalCores: { status: 'unsupported', source: 'browser', note: 'Hardware probe is not available in the browser.' },
      brand: { status: 'unsupported', source: 'browser', note: 'Hardware probe is not available in the browser.' },
    },
    ram: {
      totalMib: { status: 'unsupported', source: 'browser', note: 'Hardware probe is not available in the browser.' },
      availableMib: { status: 'unsupported', source: 'browser', note: 'Hardware probe is not available in the browser.' },
    },
    gpuInventory: {
      status: 'unsupported',
      source: 'browser',
      note: 'Hardware probe is only available in the Tauri desktop app.',
      devices: [],
    },
    warnings: [],
  };
}

function errorProfile(message: string): HardwareProfile {
  return {
    platform: 'unknown',
    timestamp: new Date().toISOString(),
    cpu: {
      logicalCores: { status: 'unknown', source: 'probe', note: message },
      physicalCores: { status: 'unknown', source: 'probe', note: message },
      brand: { status: 'unknown', source: 'probe', note: message },
    },
    ram: {
      totalMib: { status: 'unknown', source: 'probe', note: message },
      availableMib: { status: 'unknown', source: 'probe', note: message },
    },
    gpuInventory: {
      status: 'error',
      source: 'probe',
      note: message,
      devices: [],
    },
    warnings: [message],
  };
}

/**
 * Request a read-only hardware profile from the Tauri backend.
 *
 * In a browser/non-Tauri context this returns an honest `unsupported` profile
 * without trying to detect hardware.  Any Tauri invocation failure is turned
 * into a structured `error` profile rather than throwing, so callers can show a
 * deterministic reason.
 */
export async function getHardwareProfile(): Promise<HardwareProfile> {
  if (!isTauri()) {
    return browserUnsupportedProfile();
  }

  const win = typeof window !== 'undefined' ? (window as any) : undefined;
  const invoke = win?.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') {
    return errorProfile('Tauri core.invoke is not available despite isTauri() returning true.');
  }

  try {
    return (await invoke('probe_hardware')) as HardwareProfile;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return errorProfile(`probe_hardware Tauri command failed: ${message}`);
  }
}
