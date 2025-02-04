/**
 * @since 1.0.0
 */
import type { Predicate } from "@effect/data/Predicate"
import type * as Queue from "@effect/io/Queue"
import * as internal from "@effect/stream/internal/groupBy"
import type * as Stream from "@effect/stream/Stream"
import type * as Take from "@effect/stream/Take"

/**
 * @since 1.0.0
 * @category symbols
 */
export const GroupByTypeId: unique symbol = internal.GroupByTypeId

/**
 * @since 1.0.0
 * @category symbols
 */
export type GroupByTypeId = typeof GroupByTypeId

/**
 * Representation of a grouped stream. This allows to filter which groups will
 * be processed. Once this is applied all groups will be processed in parallel
 * and the results will be merged in arbitrary order.
 *
 * @since 1.0.0
 * @category models
 */
export interface GroupBy<R, E, K, V> extends GroupBy.Variance<R, E, K, V> {
  readonly grouped: Stream.Stream<R, E, readonly [K, Queue.Dequeue<Take.Take<E, V>>]>
}

/**
 * @since 1.0.0
 */
export declare namespace GroupBy {
  /**
   * @since 1.0.0
   * @category models
   */
  export interface Variance<R, E, K, V> {
    readonly [GroupByTypeId]: {
      readonly _R: (_: never) => R
      readonly _E: (_: never) => E
      readonly _K: (_: never) => K
      readonly _V: (_: never) => V
    }
  }
}

/**
 * Run the function across all groups, collecting the results in an
 * arbitrary order.
 *
 * @since 1.0.0
 * @category destructors
 */
export const evaluate: {
  <K, E, V, R2, E2, A>(
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>
  ): <R>(self: GroupBy<R, E, K, V>) => Stream.Stream<R2 | R, E | E2, A>
  <R, K, E, V, R2, E2, A>(
    self: GroupBy<R, E, K, V>,
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>
  ): Stream.Stream<R | R2, E | E2, A>
} = internal.evaluate

/**
 * Like `evaluate`, but with a configurable `bufferSize` parameter.
 *
 * @since 1.0.0
 * @category destructors
 */
export const evaluateBuffer: {
  <K, E, V, R2, E2, A>(
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>,
    bufferSize: number
  ): <R>(self: GroupBy<R, E, K, V>) => Stream.Stream<R2 | R, E | E2, A>
  <R, K, E, V, R2, E2, A>(
    self: GroupBy<R, E, K, V>,
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>,
    bufferSize: number
  ): Stream.Stream<R | R2, E | E2, A>
} = internal.evaluateBuffer

/**
 * Filter the groups to be processed.
 *
 * @since 1.0.0
 * @category utils
 */
export const filter: {
  <K>(predicate: Predicate<K>): <R, E, V>(self: GroupBy<R, E, K, V>) => GroupBy<R, E, K, V>
  <R, E, V, K>(self: GroupBy<R, E, K, V>, predicate: Predicate<K>): GroupBy<R, E, K, V>
} = internal.filter

/**
 * Only consider the first `n` groups found in the `Stream`.
 *
 * @since 1.0.0
 * @category utils
 */
export const first: {
  (n: number): <R, E, K, V>(self: GroupBy<R, E, K, V>) => GroupBy<R, E, K, V>
  <R, E, K, V>(self: GroupBy<R, E, K, V>, n: number): GroupBy<R, E, K, V>
} = internal.first

/**
 * Constructs a `GroupBy` from a `Stream`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make: <R, E, K, V>(
  grouped: Stream.Stream<R, E, readonly [K, Queue.Dequeue<Take.Take<E, V>>]>
) => GroupBy<R, E, K, V> = internal.make
