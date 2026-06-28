// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useStore } from "../src/renderer/stores/main-store.js";

let mockReq: any; let mockRt: any;
vi.mock("../src/renderer/services/phase3-runtime.js", () => ({ getRuntime: () => mockRt }));
import { navigateToGroupOverview } from "../src/renderer/services/group-navigation.js";

describe("navigateToGroupOverview", () => {
  beforeEach(() => { vi.clearAllMocks(); mockReq = vi.fn().mockResolvedValue(undefined); mockRt = { requestGroupSync: mockReq }; useStore.getState().reset(); });
  it("navigates + refreshes", () => { useStore.getState().setSelectedGroupId("g-1"); navigateToGroupOverview(); expect(useStore.getState().currentPage).toBe("overview"); expect(mockReq).toHaveBeenCalledWith("g-1"); });
  it("no crash no group", () => { navigateToGroupOverview(); expect(useStore.getState().currentPage).toBe("overview"); expect(mockReq).not.toHaveBeenCalled(); });
  it("no crash no runtime", () => { mockRt = null; useStore.getState().setSelectedGroupId("g-1"); navigateToGroupOverview(); expect(useStore.getState().currentPage).toBe("overview"); });
});
