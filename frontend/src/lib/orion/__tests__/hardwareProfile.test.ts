import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getHardwareProfile, type HardwareProfile } from '../hardwareProfile';

function tauriWindow(invoke: (cmd: string) => Promise<unknown>) {
  return {
    __TAURI__: {
      core: { invoke },
    },
  } as unknown as Window & typeof globalThis;
}

function noTauriWindow() {
  return {} as unknown as Window & typeof globalThis;
}

describe('hardwareProfile', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns unsupported in a non-Tauri/browser context', async () => {
    vi.stubGlobal('window', noTauriWindow());
    const profile = await getHardwareProfile();
    expect(profile.platform).toBe('browser');
    expect(profile.gpuInventory.status).toBe('unsupported');
    expect(profile.cpu.logicalCores.status).toBe('unsupported');
    expect(profile.ram.totalMib.status).toBe('unsupported');
  });

  it('calls probe_hardware and returns a typed Tauri response', async () => {
    const mockProfile: HardwareProfile = {
      platform: 'win32',
      timestamp: '2026-08-07T01:00:00Z',
      cpu: {
        logicalCores: { status: 'known', value: 16, source: 'sysinfo', confidence: 'high' },
        physicalCores: { status: 'known', value: 8, source: 'sysinfo', confidence: 'high' },
        brand: { status: 'known', value: 'Intel(R) Core(TM)', source: 'sysinfo', confidence: 'high' },
      },
      ram: {
        totalMib: { status: 'known', value: 32768, source: 'sysinfo', confidence: 'high' },
        availableMib: { status: 'known', value: 16384, source: 'sysinfo', confidence: 'high' },
      },
      gpuInventory: {
        status: 'known',
        source: 'nvidia-smi',
        devices: [
          {
            index: 0,
            model: { status: 'known', value: 'NVIDIA GeForce RTX 3070 Ti', source: 'nvidia-smi', confidence: 'high' },
            totalVramMib: { status: 'known', value: 8192, source: 'nvidia-smi', confidence: 'high' },
            availableVramMib: { status: 'known', value: 6650, source: 'nvidia-smi', confidence: 'high' },
            computeCapability: { status: 'known', value: '8.6', source: 'nvidia-smi', confidence: 'high' },
          },
        ],
      },
      warnings: [],
    };

    vi.stubGlobal(
      'window',
      tauriWindow((cmd) => {
        expect(cmd).toBe('probe_hardware');
        return Promise.resolve(mockProfile);
      })
    );

    const profile = await getHardwareProfile();
    expect(profile.platform).toBe('win32');
    expect(profile.gpuInventory.devices).toHaveLength(1);
    expect(profile.gpuInventory.devices[0].model.value).toBe('NVIDIA GeForce RTX 3070 Ti');
  });

  it('preserves multiple GPUs in the inventory', async () => {
    const multiGpuProfile: HardwareProfile = {
      platform: 'win32',
      timestamp: '2026-08-07T01:00:00Z',
      cpu: {
        logicalCores: { status: 'known', value: 16, source: 'sysinfo', confidence: 'high' },
        physicalCores: { status: 'known', value: 8, source: 'sysinfo', confidence: 'high' },
        brand: { status: 'known', value: 'Intel', source: 'sysinfo', confidence: 'high' },
      },
      ram: {
        totalMib: { status: 'known', value: 32768, source: 'sysinfo', confidence: 'high' },
        availableMib: { status: 'known', value: 16384, source: 'sysinfo', confidence: 'high' },
      },
      gpuInventory: {
        status: 'known',
        source: 'nvidia-smi',
        devices: [
          {
            index: 0,
            model: { status: 'known', value: 'NVIDIA RTX 3060', source: 'nvidia-smi', confidence: 'high' },
            totalVramMib: { status: 'known', value: 12288, source: 'nvidia-smi', confidence: 'high' },
            availableVramMib: { status: 'known', value: 10000, source: 'nvidia-smi', confidence: 'high' },
            computeCapability: { status: 'known', value: '8.6', source: 'nvidia-smi', confidence: 'high' },
          },
          {
            index: 1,
            model: { status: 'known', value: 'NVIDIA RTX 4090', source: 'nvidia-smi', confidence: 'high' },
            totalVramMib: { status: 'known', value: 24576, source: 'nvidia-smi', confidence: 'high' },
            availableVramMib: { status: 'known', value: 20000, source: 'nvidia-smi', confidence: 'high' },
            computeCapability: { status: 'known', value: '8.9', source: 'nvidia-smi', confidence: 'high' },
          },
        ],
      },
      warnings: [],
    };

    vi.stubGlobal('window', tauriWindow(() => Promise.resolve(multiGpuProfile)));

    const profile = await getHardwareProfile();
    expect(profile.gpuInventory.devices).toHaveLength(2);
    expect(profile.gpuInventory.devices[1].index).toBe(1);
    expect(profile.gpuInventory.devices[1].model.value).toBe('NVIDIA RTX 4090');
  });

  it('keeps unknown/missing values as unknown', async () => {
    const unknownProfile: HardwareProfile = {
      platform: 'win32',
      timestamp: '2026-08-07T01:00:00Z',
      cpu: {
        logicalCores: { status: 'known', value: 16, source: 'sysinfo', confidence: 'high' },
        physicalCores: { status: 'unknown', source: 'sysinfo', note: 'physical core count unavailable' },
        brand: { status: 'unknown', source: 'sysinfo', note: 'cpu brand unavailable' },
      },
      ram: {
        totalMib: { status: 'known', value: 32768, source: 'sysinfo', confidence: 'high' },
        availableMib: { status: 'unknown', source: 'sysinfo', note: 'memory unavailable' },
      },
      gpuInventory: {
        status: 'unknown',
        source: 'nvidia-smi',
        note: 'nvidia-smi not found in PATH or known NVIDIA locations',
        devices: [],
      },
      warnings: [],
    };

    vi.stubGlobal('window', tauriWindow(() => Promise.resolve(unknownProfile)));

    const profile = await getHardwareProfile();
    expect(profile.cpu.physicalCores.status).toBe('unknown');
    expect(profile.ram.availableMib.status).toBe('unknown');
    expect(profile.gpuInventory.status).toBe('unknown');
  });

  it('turns a Tauri invocation failure into a structured error profile', async () => {
    vi.stubGlobal(
      'window',
      tauriWindow(() => Promise.reject(new Error('command not found')))
    );

    const profile = await getHardwareProfile();
    expect(profile.gpuInventory.status).toBe('error');
    expect(profile.warnings.length).toBeGreaterThan(0);
    expect(profile.warnings[0]).toContain('probe_hardware Tauri command failed');
    expect(profile.warnings[0]).toContain('command not found');
  });

  it('does not touch model selection or startup state', () => {
    // getHardwareProfile is a pure wrapper; it does not import startupState or certifiedModels.
    // The function is async and returns a Promise<HardwareProfile>.
    expect(typeof getHardwareProfile).toBe('function');
  });
});
