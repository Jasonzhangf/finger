/**
 * Observer utilities for E2E tests
 * Provides common polling and condition-waiting functions
 */

/**
 * Generic condition waiter with timeout
 * @param condition - Function that returns true when condition is met
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param message - Error message to throw on timeout
 * @param pollIntervalMs - Interval between condition checks (default: 100ms)
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
  pollIntervalMs: number = 100
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const result = await condition();
    if (result) return;
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timeout: ${message}`);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
