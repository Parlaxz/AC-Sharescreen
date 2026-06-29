// SPDX-License-Identifier: MIT

/**
 * Bounded-window statistics helper for tracking timing samples with
 * rolling average, median (p50), and p95 latency tracking.
 *
 * Maintains a fixed-size circular buffer. When full, oldest samples
 * are evicted (FIFO).
 */
export class BoundedWindowStats {
  private readonly buffer: number[] = [];
  private readonly capacity: number;
  private index = 0;
  private _count = 0;

  constructor(capacity: number = 250) {
    this.capacity = Math.max(1, capacity);
  }

  /** Add a sample (e.g. latency ms) to the window. */
  push(value: number): void {
    if (this._count < this.capacity) {
      this.buffer.push(value);
    } else {
      this.buffer[this.index] = value;
    }
    this.index = (this.index + 1) % this.capacity;
    this._count++;
  }

  /** Number of samples collected so far. */
  get count(): number {
    return this._count;
  }

  /** Return all samples (copy, not reference). */
  samples(): number[] {
    if (this._count === 0) return [];
    if (this._count <= this.capacity) {
      return [...this.buffer];
    }
    // Circular buffer: reorder so oldest first
    const ordered: number[] = [];
    for (let i = 0; i < this.capacity; i++) {
      ordered.push(this.buffer[(this.index + i) % this.capacity]);
    }
    return ordered;
  }

  /** Arithmetic mean of all samples in the window, or NaN if empty. */
  average(): number {
    if (this._count === 0) return NaN;
    const data = this.samples();
    let sum = 0;
    for (const v of data) sum += v;
    return sum / data.length;
  }

  /**
   * Return the p-th percentile value (0–100) using linear interpolation.
   * Returns NaN if no samples.
   */
  percentile(p: number): number {
    if (this._count === 0) return NaN;
    if (p < 0 || p > 100) return NaN;
    const data = this.samples().sort((a, b) => a - b);
    const n = data.length;
    if (n === 1) return data[0];
    const rank = (p / 100) * (n - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return data[lower];
    const frac = rank - lower;
    return data[lower]! * (1 - frac) + data[upper]! * frac;
  }

  /** Median (p50). */
  median(): number {
    return this.percentile(50);
  }

  /** 95th percentile (p95). */
  p95(): number {
    return this.percentile(95);
  }

  /** Reset all samples. */
  reset(): void {
    this.buffer.length = 0;
    this.index = 0;
    this._count = 0;
  }

  /** Most recent sample, or NaN if empty. */
  latest(): number {
    if (this._count === 0) return NaN;
    if (this._count <= this.capacity) {
      return this.buffer[this.buffer.length - 1]!;
    }
    const last = (this.index - 1 + this.capacity) % this.capacity;
    return this.buffer[last]!;
  }
}
