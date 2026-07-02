/**
 * Motion utility for animated numeric counters.
 *
 * Sprint 3 (v0.1.3) — count-up animation for hero metric / KPI values.
 * Wraps svelte/motion's `tweened` with our standard 600ms cubicOut
 * easing, so every counter in the app animates consistently.
 *
 * Usage:
 *   const net = tweenNumber(0, 600);
 *   $: if (currentMember) net.set(currentMember.net);
 *   {fmt($net)}
 *
 * Why a wrapper:
 *   The default svelte/motion `tweened` import requires us to pass
 *   duration + easing on every call site. Centralizing the preset
 *   here means future tunings (e.g. switching to cubicInOut) happen
 *   in one place, and call sites stay declarative.
 */
import { tweened, type Tweened } from 'svelte/motion';
import { cubicOut } from 'svelte/easing';

/**
 * Build a tweened numeric store with our default easing.
 *
 * @param initial     starting value (default 0)
 * @param durationMs  animation duration in ms (default 600)
 * @returns a Tweened<number> store; call .set(n) to animate to a new value
 */
export function tweenNumber(
  initial: number = 0,
  durationMs: number = 600
): Tweened<number> {
  return tweened(initial, { duration: durationMs, easing: cubicOut });
}
