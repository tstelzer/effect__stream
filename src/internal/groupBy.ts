import * as Chunk from "@effect/data/Chunk"
import { dual, pipe } from "@effect/data/Function"
import * as Option from "@effect/data/Option"
import type { Predicate } from "@effect/data/Predicate"
import * as Cause from "@effect/io/Cause"
import * as Deferred from "@effect/io/Deferred"
import * as Effect from "@effect/io/Effect"
import * as Exit from "@effect/io/Exit"
import * as Queue from "@effect/io/Queue"
import * as Ref from "@effect/io/Ref"
import type * as Channel from "@effect/stream/Channel"
import type * as GroupBy from "@effect/stream/GroupBy"
import * as channel from "@effect/stream/internal/channel"
import * as channelExecutor from "@effect/stream/internal/channel/channelExecutor"
import * as core from "@effect/stream/internal/core"
import * as stream from "@effect/stream/internal/stream"
import * as take from "@effect/stream/internal/take"
import type * as Stream from "@effect/stream/Stream"
import type * as Take from "@effect/stream/Take"

/** @internal */
const GroupBySymbolKey = "@effect/stream/GroupBy"

/** @internal */
export const GroupByTypeId: GroupBy.GroupByTypeId = Symbol.for(
  GroupBySymbolKey
) as GroupBy.GroupByTypeId

/** @internal */
const groupByVariance = {
  _R: (_: never) => _,
  _E: (_: never) => _,
  _K: (_: never) => _,
  _V: (_: never) => _
}

/** @internal */
export const evaluate = dual<
  <K, E, V, R2, E2, A>(
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>
  ) => <R>(self: GroupBy.GroupBy<R, E, K, V>) => Stream.Stream<R2 | R, E | E2, A>,
  <R, K, E, V, R2, E2, A>(
    self: GroupBy.GroupBy<R, E, K, V>,
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>
  ) => Stream.Stream<R2 | R, E | E2, A>
>(
  2,
  <R, K, E, V, R2, E2, A>(
    self: GroupBy.GroupBy<R, E, K, V>,
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>
  ): Stream.Stream<R | R2, E | E2, A> => evaluateBuffer(self, f, 16)
)

/** @internal */
export const evaluateBuffer = dual<
  <K, E, V, R2, E2, A>(
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>,
    bufferSize: number
  ) => <R>(self: GroupBy.GroupBy<R, E, K, V>) => Stream.Stream<R2 | R, E | E2, A>,
  <R, K, E, V, R2, E2, A>(
    self: GroupBy.GroupBy<R, E, K, V>,
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>,
    bufferSize: number
  ) => Stream.Stream<R2 | R, E | E2, A>
>(
  3,
  <R, K, E, V, R2, E2, A>(
    self: GroupBy.GroupBy<R, E, K, V>,
    f: (key: K, stream: Stream.Stream<never, E, V>) => Stream.Stream<R2, E2, A>,
    bufferSize: number
  ): Stream.Stream<R | R2, E | E2, A> =>
    stream.flatMapParBuffer(
      self.grouped,
      ([key, queue]) => f(key, stream.flattenTake(stream.fromQueueWithShutdown(queue))),
      Number.POSITIVE_INFINITY,
      bufferSize
    )
)

/** @internal */
export const filter = dual<
  <K>(predicate: Predicate<K>) => <R, E, V>(self: GroupBy.GroupBy<R, E, K, V>) => GroupBy.GroupBy<R, E, K, V>,
  <R, E, V, K>(self: GroupBy.GroupBy<R, E, K, V>, predicate: Predicate<K>) => GroupBy.GroupBy<R, E, K, V>
>(2, <R, E, V, K>(self: GroupBy.GroupBy<R, E, K, V>, predicate: Predicate<K>): GroupBy.GroupBy<R, E, K, V> =>
  make(
    pipe(
      self.grouped,
      stream.filterEffect((tuple) => {
        if (predicate(tuple[0])) {
          return pipe(Effect.succeed(tuple), Effect.as(true))
        }
        return pipe(Queue.shutdown(tuple[1]), Effect.as(false))
      })
    )
  ))

/** @internal */
export const first = dual<
  (n: number) => <R, E, K, V>(self: GroupBy.GroupBy<R, E, K, V>) => GroupBy.GroupBy<R, E, K, V>,
  <R, E, K, V>(self: GroupBy.GroupBy<R, E, K, V>, n: number) => GroupBy.GroupBy<R, E, K, V>
>(2, <R, E, K, V>(self: GroupBy.GroupBy<R, E, K, V>, n: number): GroupBy.GroupBy<R, E, K, V> =>
  make(
    pipe(
      stream.zipWithIndex(self.grouped),
      stream.filterEffect((tuple) => {
        const index = tuple[1]
        const queue = tuple[0][1]
        if (index < n) {
          return pipe(Effect.succeed(tuple), Effect.as(true))
        }
        return pipe(Queue.shutdown(queue), Effect.as(false))
      }),
      stream.map((tuple) => tuple[0])
    )
  ))

/** @internal */
export const make = <R, E, K, V>(
  grouped: Stream.Stream<R, E, readonly [K, Queue.Dequeue<Take.Take<E, V>>]>
): GroupBy.GroupBy<R, E, K, V> => ({
  [GroupByTypeId]: groupByVariance,
  grouped
})

// Circular with Stream

/** @internal */
export const groupBy = dual<
  <A, R2, E2, K, V>(
    f: (a: A) => Effect.Effect<R2, E2, readonly [K, V]>
  ) => <R, E>(self: Stream.Stream<R, E, A>) => GroupBy.GroupBy<R2 | R, E2 | E, K, V>,
  <R, E, A, R2, E2, K, V>(
    self: Stream.Stream<R, E, A>,
    f: (a: A) => Effect.Effect<R2, E2, readonly [K, V]>
  ) => GroupBy.GroupBy<R2 | R, E2 | E, K, V>
>(
  2,
  <R, E, A, R2, E2, K, V>(
    self: Stream.Stream<R, E, A>,
    f: (a: A) => Effect.Effect<R2, E2, readonly [K, V]>
  ): GroupBy.GroupBy<R | R2, E | E2, K, V> => groupByBuffer(self, f, 16)
)

/** @internal */
export const groupByBuffer = dual<
  <A, R2, E2, K, V>(
    f: (a: A) => Effect.Effect<R2, E2, readonly [K, V]>,
    bufferSize: number
  ) => <R, E>(self: Stream.Stream<R, E, A>) => GroupBy.GroupBy<R2 | R, E2 | E, K, V>,
  <R, E, A, R2, E2, K, V>(
    self: Stream.Stream<R, E, A>,
    f: (a: A) => Effect.Effect<R2, E2, readonly [K, V]>,
    bufferSize: number
  ) => GroupBy.GroupBy<R2 | R, E2 | E, K, V>
>(
  3,
  <R, E, A, R2, E2, K, V>(
    self: Stream.Stream<R, E, A>,
    f: (a: A) => Effect.Effect<R2, E2, readonly [K, V]>,
    bufferSize: number
  ): GroupBy.GroupBy<R | R2, E | E2, K, V> =>
    make(
      stream.unwrapScoped(
        Effect.gen(function*($) {
          const decider = yield* $(
            Deferred.make<
              never,
              (key: K, value: V) => Effect.Effect<never, never, Predicate<number>>
            >()
          )
          const output = yield* $(Effect.acquireRelease(
            Queue.bounded<Exit.Exit<Option.Option<E | E2>, readonly [K, Queue.Dequeue<Take.Take<E | E2, V>>]>>(
              bufferSize
            ),
            (queue) => Queue.shutdown(queue)
          ))
          const ref = yield* $(Ref.make<Map<K, number>>(new Map()))
          const add = yield* $(
            pipe(
              stream.mapEffect(self, f),
              stream.distributedWithDynamicCallback(
                bufferSize,
                ([key, value]) => pipe(Deferred.await(decider), Effect.flatMap((f) => f(key, value))),
                (exit) => Queue.offer(output, exit)
              )
            )
          )
          yield* $(
            pipe(
              Deferred.succeed(decider, (key, _) =>
                pipe(
                  Ref.get(ref),
                  Effect.map((map) => Option.fromNullable(map.get(key))),
                  Effect.flatMap(Option.match(
                    () =>
                      pipe(
                        add,
                        Effect.flatMap(([index, queue]) =>
                          pipe(
                            Ref.update(ref, (map) => map.set(key, index)),
                            Effect.zipRight(
                              pipe(
                                Queue.offer(
                                  output,
                                  Exit.succeed(
                                    [
                                      key,
                                      mapDequeue(queue, (exit) =>
                                        new take.TakeImpl(pipe(
                                          exit,
                                          Exit.map((tuple) => Chunk.of(tuple[1]))
                                        )))
                                    ] as const
                                  )
                                ),
                                Effect.as<Predicate<number>>((n: number) => n === index)
                              )
                            )
                          )
                        )
                      ),
                    (index) => Effect.succeed<Predicate<number>>((n: number) => n === index)
                  ))
                ))
            )
          )
          return stream.flattenExitOption(stream.fromQueueWithShutdown(output))
        })
      )
    )
)

const mapDequeue = <A, B>(dequeue: Queue.Dequeue<A>, f: (a: A) => B): Queue.Dequeue<B> => new MapDequeue(dequeue, f)

class MapDequeue<A, B> implements Queue.Dequeue<B> {
  readonly [Queue.DequeueTypeId] = {
    _Out: (_: never) => _
  }

  constructor(
    readonly dequeue: Queue.Dequeue<A>,
    readonly f: (a: A) => B
  ) {
  }

  capacity(): number {
    return Queue.capacity(this.dequeue)
  }

  size(): Effect.Effect<never, never, number> {
    return Queue.size(this.dequeue)
  }

  awaitShutdown(): Effect.Effect<never, never, void> {
    return Queue.awaitShutdown(this.dequeue)
  }

  isShutdown(): Effect.Effect<never, never, boolean> {
    return Queue.isShutdown(this.dequeue)
  }

  shutdown(): Effect.Effect<never, never, void> {
    return Queue.shutdown(this.dequeue)
  }

  isFull(): Effect.Effect<never, never, boolean> {
    return Queue.isFull(this.dequeue)
  }

  isEmpty(): Effect.Effect<never, never, boolean> {
    return Queue.isEmpty(this.dequeue)
  }

  take(): Effect.Effect<never, never, B> {
    return pipe(Queue.take(this.dequeue), Effect.map((a) => this.f(a)))
  }

  takeAll(): Effect.Effect<never, never, Chunk.Chunk<B>> {
    return pipe(Queue.takeAll(this.dequeue), Effect.map(Chunk.map((a) => this.f(a))))
  }

  takeUpTo(max: number): Effect.Effect<never, never, Chunk.Chunk<B>> {
    return pipe(Queue.takeUpTo(this.dequeue, max), Effect.map(Chunk.map((a) => this.f(a))))
  }

  takeBetween(min: number, max: number): Effect.Effect<never, never, Chunk.Chunk<B>> {
    return pipe(Queue.takeBetween(this.dequeue, min, max), Effect.map(Chunk.map((a) => this.f(a))))
  }

  takeN(n: number): Effect.Effect<never, never, Chunk.Chunk<B>> {
    return pipe(Queue.takeN(this.dequeue, n), Effect.map(Chunk.map((a) => this.f(a))))
  }

  poll(): Effect.Effect<never, never, Option.Option<B>> {
    return pipe(Queue.poll(this.dequeue), Effect.map(Option.map((a) => this.f(a))))
  }
}

/** @internal */
export const groupByKey = dual<
  <A, K>(f: (a: A) => K) => <R, E>(self: Stream.Stream<R, E, A>) => GroupBy.GroupBy<R, E, K, A>,
  <R, E, A, K>(self: Stream.Stream<R, E, A>, f: (a: A) => K) => GroupBy.GroupBy<R, E, K, A>
>(
  2,
  <R, E, A, K>(self: Stream.Stream<R, E, A>, f: (a: A) => K): GroupBy.GroupBy<R, E, K, A> =>
    groupByKeyBuffer(self, f, 16)
)

/** @internal */
export const groupByKeyBuffer = dual<
  <A, K>(f: (a: A) => K, bufferSize: number) => <R, E>(self: Stream.Stream<R, E, A>) => GroupBy.GroupBy<R, E, K, A>,
  <R, E, A, K>(self: Stream.Stream<R, E, A>, f: (a: A) => K, bufferSize: number) => GroupBy.GroupBy<R, E, K, A>
>(3, <R, E, A, K>(self: Stream.Stream<R, E, A>, f: (a: A) => K, bufferSize: number): GroupBy.GroupBy<R, E, K, A> => {
  const loop = (
    map: Map<K, Queue.Queue<Take.Take<E, A>>>,
    outerQueue: Queue.Queue<Take.Take<E, readonly [K, Queue.Queue<Take.Take<E, A>>]>>
  ): Channel.Channel<R, E, Chunk.Chunk<A>, unknown, E, never, unknown> =>
    core.readWithCause(
      (input: Chunk.Chunk<A>) =>
        pipe(
          core.fromEffect(
            pipe(
              input,
              groupByIterable(f),
              Effect.forEachDiscard(([key, values]) => {
                const innerQueue = map.get(key)
                if (innerQueue === undefined) {
                  return pipe(
                    Queue.bounded<Take.Take<E, A>>(bufferSize),
                    Effect.flatMap((innerQueue) =>
                      pipe(
                        Effect.sync(() => {
                          map.set(key, innerQueue)
                        }),
                        Effect.zipRight(
                          Queue.offer(outerQueue, take.of([key, innerQueue] as const))
                        ),
                        Effect.zipRight(
                          pipe(
                            Queue.offer(innerQueue, take.chunk(values)),
                            Effect.catchSomeCause((cause) =>
                              Cause.isInterruptedOnly(cause) ?
                                Option.some(Effect.unit()) :
                                Option.none()
                            )
                          )
                        )
                      )
                    )
                  )
                }
                return pipe(
                  Queue.offer(innerQueue, take.chunk(values)),
                  Effect.catchSomeCause((cause) =>
                    Cause.isInterruptedOnly(cause) ?
                      Option.some(Effect.unit()) :
                      Option.none()
                  )
                )
              })
            )
          ),
          core.flatMap(() => loop(map, outerQueue))
        ),
      (cause) => core.fromEffect(Queue.offer(outerQueue, take.failCause(cause))),
      () =>
        pipe(
          core.fromEffect(
            pipe(
              map.entries(),
              Effect.forEachDiscard(([_, innerQueue]) =>
                pipe(
                  Queue.offer(innerQueue, take.end),
                  Effect.catchSomeCause((cause) =>
                    Cause.isInterruptedOnly(cause) ?
                      Option.some(Effect.unit()) :
                      Option.none()
                  )
                )
              ),
              Effect.zipRight(Queue.offer(outerQueue, take.end))
            )
          )
        )
    )
  return make(stream.unwrapScoped(
    pipe(
      Effect.sync(() => new Map<K, Queue.Queue<Take.Take<E, A>>>()),
      Effect.flatMap((map) =>
        pipe(
          Effect.acquireRelease(
            Queue.unbounded<Take.Take<E, readonly [K, Queue.Queue<Take.Take<E, A>>]>>(),
            (queue) => Queue.shutdown(queue)
          ),
          Effect.flatMap((queue) =>
            pipe(
              self.channel,
              core.pipeTo(loop(map, queue)),
              channel.drain,
              channelExecutor.runScoped,
              Effect.forkScoped,
              Effect.as(stream.flattenTake(stream.fromQueueWithShutdown(queue)))
            )
          )
        )
      )
    )
  ))
})

/** @internal */
export const mapEffectParByKey = dual<
  <R2, E2, A2, A, K>(
    f: (a: A) => Effect.Effect<R2, E2, A2>,
    keyBy: (a: A) => K
  ) => <R, E>(self: Stream.Stream<R, E, A>) => Stream.Stream<R2 | R, E2 | E, A2>,
  <R, E, R2, E2, A2, A, K>(
    self: Stream.Stream<R, E, A>,
    f: (a: A) => Effect.Effect<R2, E2, A2>,
    keyBy: (a: A) => K
  ) => Stream.Stream<R2 | R, E2 | E, A2>
>(
  3,
  <R, E, R2, E2, A2, A, K>(
    self: Stream.Stream<R, E, A>,
    f: (a: A) => Effect.Effect<R2, E2, A2>,
    keyBy: (a: A) => K
  ): Stream.Stream<R | R2, E | E2, A2> => mapEffectParByKeyBuffer(self, f, keyBy, 16)
)

/** @internal */
export const mapEffectParByKeyBuffer = dual<
  <R2, E2, A2, A, K>(
    f: (a: A) => Effect.Effect<R2, E2, A2>,
    keyBy: (a: A) => K,
    bufferSize: number
  ) => <R, E>(self: Stream.Stream<R, E, A>) => Stream.Stream<R2 | R, E2 | E, A2>,
  <R, E, R2, E2, A2, A, K>(
    self: Stream.Stream<R, E, A>,
    f: (a: A) => Effect.Effect<R2, E2, A2>,
    keyBy: (a: A) => K,
    bufferSize: number
  ) => Stream.Stream<R2 | R, E2 | E, A2>
>(
  4,
  <R, E, R2, E2, A2, A, K>(
    self: Stream.Stream<R, E, A>,
    f: (a: A) => Effect.Effect<R2, E2, A2>,
    keyBy: (a: A) => K,
    bufferSize: number
  ): Stream.Stream<R | R2, E | E2, A2> =>
    pipe(
      groupByKeyBuffer(self, keyBy, bufferSize),
      evaluate((_, s) => pipe(s, stream.mapEffect(f)))
    )
)

/**
 * A variant of `groupBy` that retains the insertion order of keys.
 *
 * @internal
 */
export const groupByIterable = dual<
  <V, K>(f: (value: V) => K) => (iterable: Iterable<V>) => Chunk.Chunk<readonly [K, Chunk.Chunk<V>]>,
  <V, K>(iterable: Iterable<V>, f: (value: V) => K) => Chunk.Chunk<readonly [K, Chunk.Chunk<V>]>
>(2, <V, K>(iterable: Iterable<V>, f: (value: V) => K): Chunk.Chunk<readonly [K, Chunk.Chunk<V>]> => {
  const builder: Array<readonly [K, Array<V>]> = []
  const iterator = iterable[Symbol.iterator]()
  const map = new Map<K, Array<V>>()
  let next: IteratorResult<V, any>
  while ((next = iterator.next()) && !next.done) {
    const value = next.value
    const key = f(value)
    if (map.has(key)) {
      const innerBuilder = map.get(key)!
      innerBuilder.push(value)
    } else {
      const innerBuilder: Array<V> = [value]
      builder.push([key, innerBuilder] as const)
      map.set(key, innerBuilder)
    }
  }
  return Chunk.unsafeFromArray(
    builder.map((tuple) => [tuple[0], Chunk.unsafeFromArray(tuple[1])] as const)
  )
})
