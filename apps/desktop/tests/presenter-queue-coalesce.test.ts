/**
 * Tests for PresenterQueue coalesce-to-newest behavior.
 *
 * This is a pure JS test that validates the SPSC ring buffer logic
 * that mirrors the C++ PresenterQueue in NativePresenter.cpp.
 *
 * The key property: when the queue is full, a new push should drop
 * the OLDEST queued entry (coalesce to newest) rather than dropping
 * the incoming newest entry.
 */
import { describe, it, expect } from "vitest";

// ─── PresenterQueue (JS mirror of C++ PresenterQueue) ────────────────────

class PresenterQueue {
  private capacity: number;
  private head = 0;
  private tail = 0;
  private slots: number[];

  constructor(capacity: number) {
    this.capacity = capacity;
    this.slots = new Array(capacity).fill(-1);
  }

  /** Try to push. Returns false when full (no coalesce). */
  tryPush(slotIndex: number): boolean {
    if (this.tail - this.head >= this.capacity) {
      return false; // Full
    }
    this.slots[this.tail % this.capacity] = slotIndex;
    this.tail++;
    return true;
  }

  /**
   * Push with coalesce-to-newest behavior.
   * When full, drops the oldest entry and accepts the newest.
   * Returns the dropped slot index, or -1 if nothing was dropped.
   */
  pushOrCoalesce(slotIndex: number): number {
    if (this.tail - this.head < this.capacity) {
      // Room available
      this.slots[this.tail % this.capacity] = slotIndex;
      this.tail++;
      return -1; // nothing dropped
    }

    // Queue full: drop the oldest entry
    const droppedSlot = this.slots[this.head % this.capacity];
    this.head++; // advance head (drop oldest)

    // Now push the new entry
    this.slots[this.tail % this.capacity] = slotIndex;
    this.tail++;
    return droppedSlot;
  }

  /** Try to pop. Returns -1 when empty. */
  tryPop(): number {
    if (this.head >= this.tail) {
      return -1; // Empty
    }
    const slotIndex = this.slots[this.head % this.capacity];
    this.head++;
    return slotIndex;
  }

  get size(): number {
    return this.tail - this.head;
  }

  get isFull(): boolean {
    return this.size >= this.capacity;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("PresenterQueue (SPSC ring buffer)", () => {
  it("accepts up to capacity items", () => {
    const q = new PresenterQueue(3);
    expect(q.tryPush(0)).toBe(true);
    expect(q.tryPush(1)).toBe(true);
    expect(q.tryPush(2)).toBe(true);
    expect(q.isFull).toBe(true);
  });

  it("rejects push when full (no coalesce)", () => {
    const q = new PresenterQueue(3);
    q.tryPush(0);
    q.tryPush(1);
    q.tryPush(2);
    expect(q.tryPush(3)).toBe(false); // Full - rejected
  });

  it("pops items in FIFO order", () => {
    const q = new PresenterQueue(3);
    q.tryPush(10);
    q.tryPush(20);
    q.tryPush(30);

    expect(q.tryPop()).toBe(10);
    expect(q.tryPop()).toBe(20);
    expect(q.tryPop()).toBe(30);
    expect(q.isEmpty).toBe(true);
  });

  it("returns -1 on pop from empty queue", () => {
    const q = new PresenterQueue(3);
    expect(q.tryPop()).toBe(-1);
  });

  it("wraps around correctly (ring buffer)", () => {
    const q = new PresenterQueue(3);

    // Fill and drain once
    q.tryPush(1);
    q.tryPush(2);
    q.tryPush(3);
    q.tryPop(); // 1
    q.tryPop(); // 2

    // Push more (wraps around in ring)
    q.tryPush(4);
    q.tryPush(5);

    expect(q.tryPop()).toBe(3);
    expect(q.tryPop()).toBe(4);
    expect(q.tryPop()).toBe(5);
    expect(q.isEmpty).toBe(true);
  });
});

describe("PresenterQueue coalesce-to-newest (pushOrCoalesce)", () => {
  it("pushOrCoalesce drops oldest when full, inserts newest", () => {
    const q = new PresenterQueue(3);

    // Fill the queue
    expect(q.pushOrCoalesce(10)).toBe(-1); // nothing dropped
    expect(q.pushOrCoalesce(20)).toBe(-1);
    expect(q.pushOrCoalesce(30)).toBe(-1);
    expect(q.isFull).toBe(true);

    // Now push while full - should drop oldest (10) and accept newest (40)
    const dropped = q.pushOrCoalesce(40);
    expect(dropped).toBe(10); // oldest was dropped
    expect(q.size).toBe(3); // still 3 items

    // Queue should contain [20, 30, 40]
    expect(q.tryPop()).toBe(20);
    expect(q.tryPop()).toBe(30);
    expect(q.tryPop()).toBe(40);
    expect(q.isEmpty).toBe(true);
  });

  it("multiple coalesces maintain correct order", () => {
    const q = new PresenterQueue(3);

    // Fill
    q.pushOrCoalesce(1);
    q.pushOrCoalesce(2);
    q.pushOrCoalesce(3);

    // Coalesce twice
    expect(q.pushOrCoalesce(4)).toBe(1); // dropped 1, inserted 4 -> [2,3,4]
    expect(q.pushOrCoalesce(5)).toBe(2); // dropped 2, inserted 5 -> [3,4,5]

    // Verify content
    expect(q.tryPop()).toBe(3);
    expect(q.tryPop()).toBe(4);
    expect(q.tryPop()).toBe(5);
    expect(q.isEmpty).toBe(true);
  });

  it("coalesce when partially filled still works", () => {
    const q = new PresenterQueue(3);

    // Add 2 items
    q.pushOrCoalesce(100);
    q.pushOrCoalesce(200);

    // Add third (fills)
    q.pushOrCoalesce(300);
    expect(q.isFull).toBe(true);

    // Add fourth (coalesces)
    q.pushOrCoalesce(400);

    expect(q.tryPop()).toBe(200);
    expect(q.tryPop()).toBe(300);
    expect(q.tryPop()).toBe(400);
  });

  it("never loses the newest frame even under continuous overload", () => {
    const q = new PresenterQueue(3);

    // Simulate 100 rapid pushes with coalescing
    for (let i = 0; i < 100; i++) {
      q.pushOrCoalesce(i);
    }

    // Only the last 3 items should survive
    expect(q.size).toBe(3);
    expect(q.tryPop()).toBe(97);
    expect(q.tryPop()).toBe(98);
    expect(q.tryPop()).toBe(99);
  });

  it("pushOrCoalesce with empty queue adds normally", () => {
    const q = new PresenterQueue(3);
    expect(q.pushOrCoalesce(42)).toBe(-1);
    expect(q.size).toBe(1);
    expect(q.tryPop()).toBe(42);
  });

  it("wraparound with coalesce maintains correctness", () => {
    const q = new PresenterQueue(3);

    // Fill and pop one to cause wraparound
    q.pushOrCoalesce(10);
    q.pushOrCoalesce(20);
    q.pushOrCoalesce(30);
    q.tryPop(); // remove 10

    // Queue: [20, 30], head=1, tail=4, slots=[10,20,30]
    // Next push goes at index 4 % 3 = 1
    q.pushOrCoalesce(40);
    // Queue: [20, 30, 40], head=1, tail=5

    // Fill (coalesce)
    q.pushOrCoalesce(50);
    // Dropped 20 (at wrapped head=1), inserted 50 at 5%3=2
    // Queue: [30, 40, 50]
    expect(q.size).toBe(3);

    expect(q.tryPop()).toBe(30);
    expect(q.tryPop()).toBe(40);
    expect(q.tryPop()).toBe(50);
  });
});

describe("C++ NativePresenter::EnqueueSlot coalescing behavior", () => {
  it("simulates the C++ EnqueueSlot logic: pop oldest, release, push new", () => {
    // This simulates the exact logic in NativePresenter::EnqueueSlot
    const queue = new PresenterQueue(3);
    const slots: boolean[] = [true, true, true]; // available flags

    const tryPopFromQueue = (): number => {
      return queue.tryPop();
    };

    const tryPushToQueue = (slotIndex: number): boolean => {
      if (!queue.tryPush(slotIndex)) {
        // Queue full: coalesce
        const droppedSlot = tryPopFromQueue();
        if (droppedSlot >= 0) {
          // Release the dropped slot
          slots[droppedSlot] = true;
          // Re-try push
          return queue.tryPush(slotIndex);
        }
        return false;
      }
      return true;
    };

    // Claim 3 slots
    slots[0] = false;
    expect(tryPushToQueue(0)).toBe(true);

    slots[1] = false;
    expect(tryPushToQueue(1)).toBe(true);

    slots[2] = false;
    expect(tryPushToQueue(2)).toBe(true);
    expect(queue.size).toBe(3);

    // Fourth slot - should coalesce
    slots[0] = false; // claim slot 0 again (reuse)
    const pushResult = tryPushToQueue(0);
    expect(pushResult).toBe(true);

    // The oldest (slot 0 from first push) should have been released
    expect(slots[0]).toBe(true); // first entry was released
    expect(queue.size).toBe(3);

    // Drain queue
    expect(tryPopFromQueue()).toBe(1);
    expect(tryPopFromQueue()).toBe(2);
    expect(tryPopFromQueue()).toBe(0);
  });
});
