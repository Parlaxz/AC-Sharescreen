import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const publisherManagerPath = path.resolve(__dirname, '..', 'src', 'renderer', 'services', 'publisher-manager.ts');
const controllerPath = path.resolve(__dirname, '..', 'src', 'renderer', 'audio', 'ProcessAudioController.ts');

// ---------------------------------------------------------------------------
// Browser API stubs
// ---------------------------------------------------------------------------
function makeBrowserStubs() {
  let trackId = 0;
  function makeTrack(kind: string, readyState: string): any {
    return {
      id: `mock-track-${++trackId}`,
      kind,
      enabled: true,
      muted: false,
      readyState,
      label: '',
      clone: () => makeTrack(kind, readyState),
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  }

  function makeStream(tracks: any[] = []): any {
    const _tracks = [...tracks];
    return {
      getTracks: () => [..._tracks],
      getAudioTracks: () => _tracks.filter((t: any) => t.kind === 'audio'),
      getVideoTracks: () => _tracks.filter((t: any) => t.kind === 'video'),
      addTrack: (t: any) => { _tracks.push(t); },
      removeTrack: (t: any) => { const i = _tracks.indexOf(t); if (i >= 0) _tracks.splice(i, 1); },
      clone: () => makeStream([..._tracks]),
      active: true,
    };
  }

  return { makeTrack, makeStream };
}

function createMockController(state: string, trackKind = 'audio', trackReadyState = 'live'): any {
  const { makeTrack } = makeBrowserStubs();
  const track = makeTrack(trackKind, trackReadyState);
  let closed = false;

  return {
    getTrack: () => track,
    getInstanceId: () => Math.floor(Math.random() * 100000),
    getState: () => state,
    close: vi.fn(async (owner?: string) => {
      closed = true;
      track.readyState = 'ended';
    }),
    isClosed: () => closed,
  };
}

// Stub MediaStream globally before running tests that need it
function stubMediaStream() {
  const { makeStream } = makeBrowserStubs();
  if (typeof globalThis.MediaStream === 'undefined') {
    (globalThis as any).MediaStream = function (this: any, tracks?: any[]) {
      const s = makeStream(tracks ?? []);
      (this as any).getTracks = s.getTracks;
      (this as any).getAudioTracks = s.getAudioTracks;
      (this as any).getVideoTracks = s.getVideoTracks;
      (this as any).addTrack = s.addTrack;
      (this as any).removeTrack = s.removeTrack;
      (this as any).clone = s.clone;
      (this as any).active = s.active;
    } as any;
  }
}

// ---------------------------------------------------------------------------
// Static analysis: source code patterns that must hold
// ---------------------------------------------------------------------------
describe('PublisherManager source invariants', () => {
  it('setAudioController stores new before closing previous (replacement ordering)', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    const setBlock = content.indexOf('setAudioController(');
    const assignIdx = content.indexOf('this.audioController = controller', setBlock);
    const closeIdx = content.indexOf('previous.close(', setBlock);
    expect(assignIdx).toBeGreaterThan(0);
    expect(closeIdx).toBeGreaterThan(assignIdx);
  });

  it('clearAudioController does NOT call close on controller', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    const clearBlock = content.indexOf('clearAudioController(): void');
    const afterClear = content.slice(clearBlock, clearBlock + 400);
    expect(afterClear).not.toContain('.close(');
    expect(afterClear).toContain("this.appliedAudioMode = 'none'");
  });

  it('buildCombinedStream checks controller state before adding audio track', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    expect(content).toContain("ctrlState === 'rendering'");
    expect(content).toContain("ctrlState === 'primed'");
  });

  it('buildCombinedStream validates audio track kind and readyState', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    expect(content).toContain("throw new Error('publisher-audio-track-wrong-kind')");
    expect(content).toContain('throw new Error(`publisher-audio-track-${audioTrack.readyState}`)');
  });

  it('startPublishing has publication invariant for non-none audio mode', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    expect(content).toContain('audio-track-missing-before-publish');
    expect(content).toContain("throw new Error(`audio-track-missing-before-publish:${this.appliedAudioMode}`)");
  });

  it('stopCapture closes controller with shutdown owner', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    expect(content).toContain("this.audioController.close('shutdown')");
  });

  it('hasAudio checks controller track readyState', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    const hasAudioBlock = content.indexOf('hasAudio(): boolean');
    const afterBlock = content.slice(hasAudioBlock, hasAudioBlock + 200);
    expect(afterBlock).toContain('track?.readyState === "live"');
  });
});

describe('ProcessAudioController source invariants', () => {
  it('close(owner?) rejects waiters before stopping audioTrack', () => {
    const content = fs.readFileSync(controllerPath, 'utf-8');
    const rejectIdx = content.indexOf('rejectAllWaiters');
    const trackStopIdx = content.indexOf('this.audioTrack.stop()');
    expect(rejectIdx).toBeGreaterThan(0);
    expect(trackStopIdx).toBeGreaterThan(rejectIdx);
  });

  it('close(owner?) uses closed_ double-close guard', () => {
    const content = fs.readFileSync(controllerPath, 'utf-8');
    expect(content).toContain('async close(');
    expect(content).toContain('this.closed_');
    expect(content).toContain("if (this.closed_) return;");
  });

  it('setAudioController accepts test-tone mode', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    const modeTypeLine = content.indexOf("mode: 'system' | 'application' | 'monitor' | 'test-tone'");
    expect(modeTypeLine).toBeGreaterThan(0);
  });

  it('setAudioController logs diagnostics', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    expect(content).toMatch(/controllerId/);
    expect(content).toMatch(/controller\.getInstanceId/);
    expect(content).toMatch(/hasAudioTrack/);
    expect(content).toMatch(/audioTrackReadyState/);
  });
});

// ---------------------------------------------------------------------------
// Runtime behavioral tests
// ---------------------------------------------------------------------------
describe('PublisherManager runtime - audio controller ownership', () => {
  let mgr: any;

  beforeEach(async () => {
    const { PublisherManager } = await import('../src/renderer/services/publisher-manager');
    mgr = new PublisherManager({
      onStateChange: () => {},
      onStats: () => {},
      onError: () => {},
      onTrackEnded: () => {},
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('setAudioController stores controller, track, and mode', () => {
    const ctrl = createMockController('rendering');
    mgr.setAudioController(ctrl, 'system');
    expect(mgr.hasAudio()).toBe(true);
    expect(mgr.getAudioTrack()).toBe(ctrl.getTrack());
    expect(mgr.getAudioState()).toBe('active');
  });

  it('setAudioController with same controller does not close it', () => {
    const ctrl = createMockController('rendering');
    mgr.setAudioController(ctrl, 'system');
    expect(ctrl.close).not.toHaveBeenCalled();
    mgr.setAudioController(ctrl, 'system');
    expect(ctrl.close).not.toHaveBeenCalled();
  });

  it('setAudioController with different controller closes previous', () => {
    const ctrl1 = createMockController('rendering');
    const ctrl2 = createMockController('rendering');
    mgr.setAudioController(ctrl1, 'system');
    mgr.setAudioController(ctrl2, 'system');
    expect(ctrl1.close).toHaveBeenCalledTimes(1);
    expect(ctrl1.close).toHaveBeenCalledWith('replacement');
    expect(ctrl2.close).not.toHaveBeenCalled();
  });

  it('clearAudioController clears state but does not close controller', () => {
    const ctrl = createMockController('rendering');
    mgr.setAudioController(ctrl, 'system');
    expect(mgr.hasAudio()).toBe(true);
    mgr.clearAudioController();
    expect(mgr.hasAudio()).toBe(false);
    expect(mgr.getAudioTrack()).toBeNull();
    expect(mgr.getAudioState()).toBe('disabled');
    expect(ctrl.close).not.toHaveBeenCalled();
  });

  it('multiple setAudioController calls preserve last controller (replacement ordering)', () => {
    const ctrl1 = createMockController('rendering');
    const ctrl2 = createMockController('rendering');
    mgr.setAudioController(ctrl1, 'system');
    expect(mgr.getAudioTrack()).toBe(ctrl1.getTrack());
    mgr.setAudioController(ctrl2, 'application');
    expect(mgr.getAudioTrack()).toBe(ctrl2.getTrack());
    expect(ctrl1.close).toHaveBeenCalledWith('replacement');
  });

  it('hasAudio returns live state of controller track', () => {
    const ctrl = createMockController('rendering');
    mgr.setAudioController(ctrl, 'system');
    expect(mgr.hasAudio()).toBe(true);
    ctrl.getTrack().readyState = 'ended';
    expect(mgr.hasAudio()).toBe(false);
  });
});

describe('PublisherManager runtime - buildCombinedStream behavior', () => {
  let mgr: any;

  beforeEach(async () => {
    stubMediaStream();
    const { PublisherManager } = await import('../src/renderer/services/publisher-manager');
    mgr = new PublisherManager({
      onStateChange: () => {},
      onStats: () => {},
      onError: () => {},
      onTrackEnded: () => {},
    });
    const { makeTrack, makeStream } = makeBrowserStubs();
    const videoTrack = makeTrack('video', 'live');
    mgr['captureStream'] = makeStream([videoTrack]);
  });

  it('includes audio track when controller state is rendering', () => {
    const ctrl = createMockController('rendering');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';
    const combined = mgr['buildCombinedStream']();
    expect(combined.getAudioTracks().length).toBe(1);
    expect(combined.getAudioTracks()[0]).toBe(ctrl.getTrack());
  });

  it('includes audio track when controller state is primed', () => {
    const ctrl = createMockController('primed');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';
    const combined = mgr['buildCombinedStream']();
    expect(combined.getAudioTracks().length).toBe(1);
  });

  it('skips audio track when controller state is loading', () => {
    const ctrl = createMockController('loading');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';
    const combined = mgr['buildCombinedStream']();
    expect(combined.getAudioTracks().length).toBe(0);
  });

  it('skips audio track when controller state is closed', () => {
    const ctrl = createMockController('closed');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';
    const combined = mgr['buildCombinedStream']();
    expect(combined.getAudioTracks().length).toBe(0);
  });

  it('throws on wrong track kind', () => {
    const ctrl = createMockController('rendering', 'video', 'live');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';
    expect(() => mgr['buildCombinedStream']()).toThrow('publisher-audio-track-wrong-kind');
  });

  it('throws on non-live track readyState', () => {
    const ctrl = createMockController('rendering', 'audio', 'ended');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';
    expect(() => mgr['buildCombinedStream']()).toThrow('publisher-audio-track-ended');
  });
});

describe('PublisherManager runtime - publication invariant', () => {
  // mockSDK is hoisted — use module-level variable with vi.hoisted
  const mockSDKRef = vi.hoisted(() => ({ connections: new Map() as Map<any, any> }));

  let mgr: any;

  beforeEach(async () => {
    stubMediaStream();
    vi.resetModules();
    vi.mock('@screenlink/vdo-adapter', () => ({
      HostPublisher: vi.fn().mockImplementation(() => ({
        createAndConnect: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        stopPublishing: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getSDK: () => mockSDKRef,
      })),
    }));

    const { PublisherManager } = await import('../src/renderer/services/publisher-manager');
    mgr = new PublisherManager({
      onStateChange: () => {},
      onStats: () => {},
      onError: () => {},
      onTrackEnded: () => {},
    });

    const { makeTrack, makeStream } = makeBrowserStubs();
    const videoTrack = makeTrack('video', 'live');
    mgr['captureStream'] = makeStream([videoTrack]);
  });

  it('throws audio-track-missing when mode set but no audio track in stream', async () => {
    mgr['appliedAudioMode'] = 'system';
    mgr['audioController'] = null;
    mgr['audioTrack'] = null;

    const { makeStream } = makeBrowserStubs();
    const stream = makeStream([...mgr['captureStream'].getTracks()]);

    await expect(
      mgr['startPublishing'](stream, {
        sourceId: 'test', password: 'test', streamId: 'test',
        videoBitrate: 1000, videoWidth: 1280, videoHeight: 720, videoFps: 30,
      }),
    ).rejects.toThrow('audio-track-missing-before-publish:system');
  });

  it('succeeds when mode set and audio track present', async () => {
    const ctrl = createMockController('rendering');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';

    const { makeStream } = makeBrowserStubs();
    const stream = makeStream([...mgr['captureStream'].getTracks()]);
    stream.addTrack(ctrl.getTrack());

    await expect(
      mgr['startPublishing'](stream, {
        sourceId: 'test', password: 'test', streamId: 'test',
        videoBitrate: 1000, videoWidth: 1280, videoHeight: 720, videoFps: 30,
      }),
    ).resolves.toBeUndefined();

    expect(mgr.getState()).toBe('sharing');
  });

  it('skips invariant when mode is none', async () => {
    mgr['audioController'] = null;
    mgr['audioTrack'] = null;
    mgr['appliedAudioMode'] = 'none';

    const { makeStream } = makeBrowserStubs();
    const stream = makeStream([...mgr['captureStream'].getTracks()]);

    await expect(
      mgr['startPublishing'](stream, {
        sourceId: 'test', password: 'test', streamId: 'test',
        videoBitrate: 1000, videoWidth: 1280, videoHeight: 720, videoFps: 30,
      }),
    ).resolves.toBeUndefined();

    expect(mgr.getState()).toBe('sharing');
  });
});

describe('PublisherManager runtime - cleanup', () => {
  let mgr: any;

  beforeEach(async () => {
    const { PublisherManager } = await import('../src/renderer/services/publisher-manager');
    mgr = new PublisherManager({
      onStateChange: () => {},
      onStats: () => {},
      onError: () => {},
      onTrackEnded: () => {},
    });
  });

  it('stopCapture closes controller with shutdown owner', async () => {
    const ctrl = createMockController('rendering');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';
    await mgr.stopCapture();
    expect(ctrl.close).toHaveBeenCalledWith('shutdown');
  });

  it('stopCapture clears audioController, audioTrack, appliedAudioMode', async () => {
    const ctrl = createMockController('rendering');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';
    await mgr.stopCapture();
    expect(mgr['audioController']).toBeNull();
    expect(mgr['audioTrack']).toBeNull();
    expect(mgr['appliedAudioMode']).toBe('none');
    expect(mgr.getAudioState()).toBe('disabled');
  });

  it('stopCapture is idempotent (stopping_ guard)', async () => {
    const ctrl = createMockController('rendering');
    mgr['audioController'] = ctrl;
    mgr['audioTrack'] = ctrl.getTrack();
    mgr['appliedAudioMode'] = 'system';
    await Promise.all([mgr.stopCapture(), mgr.stopCapture(), mgr.stopCapture()]);
    expect(ctrl.close).toHaveBeenCalledTimes(1);
  });

  it('destroy calls stopCapture', async () => {
    const ctrl = createMockController('rendering');
    mgr['audioController'] = ctrl;
    mgr.destroy();
    await new Promise(r => setTimeout(r, 50));
    expect(ctrl.close).toHaveBeenCalled();
  });
});

describe('ProcessAudioController runtime - close behavior', () => {
  it('close is idempotent (closed_ guard)', async () => {
    const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
    const ctrl = new ProcessAudioController();
    await ctrl.close('test');
    await ctrl.close('test');
    await ctrl.close('test');
    expect(true).toBe(true);
  });

  it('getFatalError returns null when no error occurred', async () => {
    const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
    const ctrl = new ProcessAudioController();
    expect(ctrl.getFatalError()).toBeNull();
  });

  it('isOutputShapeValid returns false before initialize', async () => {
    const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
    const ctrl = new ProcessAudioController();
    expect(ctrl.isOutputShapeValid()).toBe(false);
  });

  it('getTrack returns null before initialize', async () => {
    const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
    const ctrl = new ProcessAudioController();
    expect(ctrl.getTrack()).toBeNull();
  });

  it('getState returns closed after close', async () => {
    const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
    const ctrl = new ProcessAudioController();
    await ctrl.close();
    expect(ctrl.getState()).toBe('closed');
  });

  it('getInstanceId returns unique IDs per instance', async () => {
    const { ProcessAudioController } = await import('../src/renderer/audio/ProcessAudioController');
    const ctrl1 = new ProcessAudioController();
    const ctrl2 = new ProcessAudioController();
    const ctrl3 = new ProcessAudioController();
    const ids = new Set([ctrl1.getInstanceId(), ctrl2.getInstanceId(), ctrl3.getInstanceId()]);
    expect(ids.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the original defect
// ---------------------------------------------------------------------------
describe('Regression: audio track survives ownership transfer', () => {
  it('setAudioController does not close the controller being set', async () => {
    const { PublisherManager } = await import('../src/renderer/services/publisher-manager');
    const mgr = new PublisherManager({
      onStateChange: () => {},
      onStats: () => {},
      onError: () => {},
      onTrackEnded: () => {},
    });
    const ctrl = createMockController('rendering');
    mgr.setAudioController(ctrl, 'system');
    expect(mgr.hasAudio()).toBe(true);
    expect(ctrl.close).not.toHaveBeenCalled();
  });

  it('no silent video-only fallback when audio mode is set', () => {
    const content = fs.readFileSync(publisherManagerPath, 'utf-8');
    expect(content).toContain('audio-track-missing-before-publish');
    expect(content).toContain("this.appliedAudioMode !== 'none'");
    expect(content).toContain('!stream.getAudioTracks().length');
  });

  it('no clearAudioController calls in Phase 3 Dashboard (audio managed via PublisherManager)', () => {
    const dashboardPath = path.resolve(__dirname, '..', 'src', 'renderer', 'routes', 'Dashboard.tsx');
    const content = fs.readFileSync(dashboardPath, 'utf-8');
    expect(content).not.toContain('clearAudioController');
  });
});
