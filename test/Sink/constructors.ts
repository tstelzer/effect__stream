import type * as Chunk from "@effect/data/Chunk"
import { pipe } from "@effect/data/Function"
import type * as MutableQueue from "@effect/data/MutableQueue"
import type * as MutableRef from "@effect/data/MutableRef"
import type * as Option from "@effect/data/Option"
import * as Deferred from "@effect/io/Deferred"
import * as Effect from "@effect/io/Effect"
import * as Exit from "@effect/io/Exit"
import * as Fiber from "@effect/io/Fiber"
import * as Hub from "@effect/io/Hub"
import * as internalQueue from "@effect/io/internal_effect_untraced/queue"
import * as Queue from "@effect/io/Queue"
import * as Sink from "@effect/stream/Sink"
import * as Stream from "@effect/stream/Stream"
import * as it from "@effect/stream/test/utils/extend"
import { assert, describe } from "vitest"

describe.concurrent("Sink", () => {
  it.effect("drain - fails if upstream fails", () =>
    Effect.gen(function*($) {
      const stream = pipe(
        Stream.make(1),
        Stream.mapEffect(() => Effect.fail("boom!"))
      )
      const result = yield* $(pipe(stream, Stream.run(Sink.drain()), Effect.exit))
      assert.deepStrictEqual(Exit.unannotate(result), Exit.fail("boom!"))
    }))

  it.effect("fromEffect", () =>
    Effect.gen(function*($) {
      const sink = Sink.fromEffect(Effect.succeed("ok"))
      const result = yield* $(pipe(Stream.make(1, 2, 3), Stream.run(sink)))
      assert.deepStrictEqual(result, "ok")
    }))

  it.effect("fromQueue - should enqueue all elements", () =>
    Effect.gen(function*($) {
      const queue = yield* $(Queue.unbounded<number>())
      yield* $(pipe(Stream.make(1, 2, 3), Stream.run(Sink.fromQueue(queue))))
      const result = yield* $(Queue.takeAll(queue))
      assert.deepStrictEqual(Array.from(result), [1, 2, 3])
    }))

  it.effect("fromQueueWithShutdown - should enqueue all elements and shutdown the queue", () =>
    Effect.gen(function*($) {
      const queue = yield* $(pipe(Queue.unbounded<number>(), Effect.map(createQueueSpy)))
      yield* $(pipe(Stream.make(1, 2, 3), Stream.run(Sink.fromQueueWithShutdown(queue))))
      const enqueuedValues = yield* $(Queue.takeAll(queue))
      const isShutdown = yield* $(Queue.isShutdown(queue))
      assert.deepStrictEqual(Array.from(enqueuedValues), [1, 2, 3])
      assert.isTrue(isShutdown)
    }))

  it.effect("fromHub - should publish all elements", () =>
    Effect.gen(function*($) {
      const deferred1 = yield* $(Deferred.make<never, void>())
      const deferred2 = yield* $(Deferred.make<never, void>())
      const hub = yield* $(Hub.unbounded<number>())
      const fiber = yield* $(
        pipe(
          Hub.subscribe(hub),
          Effect.flatMap((subscription) =>
            pipe(
              Deferred.succeed<never, void>(deferred1, void 0),
              Effect.zipRight(Deferred.await(deferred2)),
              Effect.zipRight(Queue.takeAll(subscription))
            )
          ),
          Effect.scoped,
          Effect.fork
        )
      )
      yield* $(Deferred.await(deferred1))
      yield* $(pipe(Stream.make(1, 2, 3), Stream.run(Sink.fromHub(hub))))
      yield* $(Deferred.succeed<never, void>(deferred2, void 0))
      const result = yield* $(Fiber.join(fiber))
      assert.deepStrictEqual(Array.from(result), [1, 2, 3])
    }))

  it.effect("fromHubWithShutdown - should shutdown the hub", () =>
    Effect.gen(function*($) {
      const hub = yield* $(Hub.unbounded<number>())
      yield* $(pipe(Stream.make(1, 2, 3), Stream.run(Sink.fromHubWithShutdown(hub))))
      const isShutdown = yield* $(Hub.isShutdown(hub))
      assert.isTrue(isShutdown)
    }))
})

const createQueueSpy = <A>(queue: Queue.Queue<A>): Queue.Queue<A> => new QueueSpy(queue)

class QueueSpy<A> implements Queue.Queue<A> {
  readonly [Queue.DequeueTypeId] = internalQueue.dequeueVariance
  readonly [Queue.EnqueueTypeId] = internalQueue.enqueueVariance
  private isShutdownInternal = false
  readonly queue: MutableQueue.MutableQueue<A>
  readonly shutdownFlag: MutableRef.MutableRef<boolean>
  readonly shutdownHook: Deferred.Deferred<never, void>
  readonly strategy: Queue.Strategy<A>
  readonly takers: MutableQueue.MutableQueue<Deferred.Deferred<never, A>>

  constructor(readonly backingQueue: Queue.Queue<A>) {
    this.queue = backingQueue.queue
    this.shutdownFlag = backingQueue.shutdownFlag
    this.shutdownHook = backingQueue.shutdownHook
    this.strategy = backingQueue.strategy
    this.takers = backingQueue.takers
  }

  offer(a: A) {
    return Queue.offer(this.backingQueue, a)
  }

  offerAll(elements: Iterable<A>) {
    return Queue.offerAll(this.backingQueue, elements)
  }

  capacity(): number {
    return Queue.capacity(this.backingQueue)
  }

  size(): Effect.Effect<never, never, number> {
    return Queue.size(this.backingQueue)
  }

  awaitShutdown(): Effect.Effect<never, never, void> {
    return Queue.awaitShutdown(this.backingQueue)
  }

  isShutdown(): Effect.Effect<never, never, boolean> {
    return Effect.sync(() => this.isShutdownInternal)
  }

  shutdown(): Effect.Effect<never, never, void> {
    return Effect.sync(() => {
      this.isShutdownInternal = true
    })
  }

  isFull(): Effect.Effect<never, never, boolean> {
    return Queue.isFull(this.backingQueue)
  }

  isEmpty(): Effect.Effect<never, never, boolean> {
    return Queue.isEmpty(this.backingQueue)
  }

  take(): Effect.Effect<never, never, A> {
    return Queue.take(this.backingQueue)
  }

  takeAll(): Effect.Effect<never, never, Chunk.Chunk<A>> {
    return Queue.takeAll(this.backingQueue)
  }

  takeUpTo(max: number): Effect.Effect<never, never, Chunk.Chunk<A>> {
    return Queue.takeUpTo(this.backingQueue, max)
  }

  takeBetween(min: number, max: number): Effect.Effect<never, never, Chunk.Chunk<A>> {
    return Queue.takeBetween(this.backingQueue, min, max)
  }

  takeN(n: number): Effect.Effect<never, never, Chunk.Chunk<A>> {
    return Queue.takeN(this.backingQueue, n)
  }

  poll(): Effect.Effect<never, never, Option.Option<A>> {
    return Queue.poll(this.backingQueue)
  }
}
