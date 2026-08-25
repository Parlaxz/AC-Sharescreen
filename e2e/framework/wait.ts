/**
 * Generic polling helper with labeled timeout errors.
 * Reused by AgentController.waitForTestId and any spec-level polling.
 */
export interface WaitForOptions {
	/** Max time to wait in ms. Default 15000. */
	timeout?: number;
	/** Poll interval in ms. Default 250. */
	interval?: number;
	/** Human-readable label used in the timeout error. */
	label?: string;
}

/**
 * Wait until `predicateFn` returns a truthy value; resolve with that value.
 * Throws a labeled Error on timeout including the last observed value/error.
 */
export async function waitFor<T>(
	predicateFn: () => T | Promise<T>,
	opts: WaitForOptions = {},
): Promise<NonNullable<T>> {
	const timeout = opts.timeout ?? 15_000;
	const interval = opts.interval ?? 250;
	const label = opts.label ?? 'condition';
	const deadline = Date.now() + timeout;

	let lastValue: unknown;
	let lastError: unknown;

	for (;;) {
		try {
			lastValue = await predicateFn();
			if (lastValue) return lastValue as NonNullable<T>;
			lastError = undefined;
		} catch (err) {
			lastError = err;
		}
		if (Date.now() >= deadline) {
			const detail =
				lastError !== undefined
					? `last error: ${String(lastError)}`
					: `last value: ${JSON.stringify(lastValue) ?? String(lastValue)}`;
			throw new Error(
				`waitFor(${label}) timed out after ${timeout}ms (${detail})`,
			);
		}
		await sleep(interval);
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
