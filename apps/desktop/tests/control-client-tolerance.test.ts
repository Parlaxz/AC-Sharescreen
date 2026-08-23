// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { ControlClient } from "../src/main/ControlClient.js";

// Exact malformed hello response observed from a helper built with an
// ungenerated build-info template ("gitDirty":@GIT_DIRTY@ is invalid JSON).
const MALFORMED_HELLO =
  '{"protocolVersion":"0.3.0","requestId":1,"sessionId":"diag-test","success":true,"state":"idle","result":{"helperVersion":"0.1.0","protocolVersion":"0.3.0","sessionId":"diag-test","pid":26536,"buildInfo":{"gitCommit":"@GIT_COMMIT@","gitDirty":@GIT_DIRTY@,"gitBranch":"@GIT_BRANCH@","buildTimestamp":"@BUILD_TIMESTAMP@","architecture":"x64","buildConfig":"@BUILD_CONFIG@","compilerId":"@COMPILER_ID@"}},"error":"null"}';

const VALID_HELLO = MALFORMED_HELLO.replace('"gitDirty":@GIT_DIRTY@', '"gitDirty":false');

let servers: net.Server[] = [];
let clients: ControlClient[] = [];

function startFakeHelper(pipeName: string, respondWith: string): void {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let responded = false;
    socket.on("data", () => {
      if (responded) return;
      responded = true;
      setTimeout(() => socket.write(respondWith + "\n"), 25);
    });
  });
  server.listen(pipeName);
  servers.push(server);
}

function uniquePipe(): string {
  return `\\\\.\\pipe\\sl-ci-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

afterEach(() => {
  for (const c of clients) {
    try {
      c.disconnect();
    } catch {
      /* ignore */
    }
  }
  clients = [];
  for (const s of servers) s.close();
  servers = [];
});

describe("ControlClient malformed-response tolerance", () => {
  it("parses hello responses containing unexpanded @PLACEHOLDER@ tokens", async () => {
    const pipeName = uniquePipe();
    startFakeHelper(pipeName, MALFORMED_HELLO);

    const cc = new ControlClient(pipeName, "diag-test", "diag-test");
    clients.push(cc);

    await cc.connect(3000);
    const resp = await cc.hello();

    expect(resp.success).toBe(true);
    expect((resp.result as Record<string, unknown>).helperVersion).toBe("0.1.0");
  });

  it("still dispatches fully valid hello responses unchanged", async () => {
    const pipeName = uniquePipe();
    startFakeHelper(pipeName, VALID_HELLO);

    const cc = new ControlClient(pipeName, "diag-test", "diag-test");
    clients.push(cc);

    await cc.connect(3000);
    const resp = await cc.hello();

    expect(resp.success).toBe(true);
    expect((resp.result as Record<string, unknown>).buildInfo).toBeDefined();
  });
});
