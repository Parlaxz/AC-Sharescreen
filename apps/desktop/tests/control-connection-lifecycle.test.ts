import { describe, it, expect } from 'vitest';

describe('ControlConnection lifecycle', () => {
  it('getControlConnection returns same instance on repeated calls', async () => {
    const mod = await import('../src/renderer/services/control-connection.js');
    const conn1 = mod.getControlConnection();
    const conn2 = mod.getControlConnection();
    expect(conn1).toBe(conn2);
  });

  it('destroy idempotent — calling twice does not throw', async () => {
    const mod = await import('../src/renderer/services/control-connection.js');
    const conn = mod.getControlConnection();
    expect(() => conn.destroy()).not.toThrow();
    expect(() => conn.destroy()).not.toThrow();
  });
});

describe('CSP policy', () => {
  it('includes TURN server origin', () => {
    const fs = require('fs');
    const html = fs.readFileSync(require('path').resolve(__dirname, '..', 'index.html'), 'utf-8');
    expect(html).toContain('https://turnservers.vdo.ninja');
    expect(html).toContain('wss://wss.vdo.ninja');
    expect(html).not.toContain("connect-src 'self' wss://wss.vdo.ninja;"); // old policy without turn
  });
});

describe('SDK logging', () => {
  it('debug mode is disabled', async () => {
    const mod = await import('../src/renderer/services/control-connection.js');
    // We can't easily inspect the SDK options, but we can verify the source
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '..', 'src', 'renderer', 'services', 'control-connection.ts'),
      'utf-8'
    );
    // debug: false should appear in the SDK constructor options
    expect(source).toContain('debug: false');
    // debug: true should NOT appear
    expect(source).not.toContain('debug: true');
  });
});

describe('Message deduplication', () => {
  it('uses seenMessageIds set for dedup', async () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '..', 'src', 'renderer', 'services', 'control-connection.ts'),
      'utf-8'
    );
    expect(source).toContain('seenMessageIds');
    expect(source).toContain('isDuplicateMessage');
  });

  it('clears dedup set periodically', async () => {
    const fs = require('fs');
    const source = fs.readFileSync(
      require('path').resolve(__dirname, '..', 'src', 'renderer', 'services', 'control-connection.ts'),
      'utf-8'
    );
    expect(source).toContain('this.seenMessageIds.clear()');
  });
});
