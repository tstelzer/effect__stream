import * as Chunk from "@effect/data/Chunk"
import * as Equal from "@effect/data/Equal"
import { identity, pipe } from "@effect/data/Function"
import * as Option from "@effect/data/Option"
import * as Effect from "@effect/io/Effect"
import * as Sink from "@effect/stream/Sink"
import * as Stream from "@effect/stream/Stream"
import * as it from "@effect/stream/test/utils/extend"
import { assert, describe } from "vitest"

describe.concurrent("Sink", () => {
  it.effect("findEffect - with head sink", () =>
    Effect.gen(function*($) {
      const sink = pipe(
        Sink.head<number>(),
        Sink.findEffect(Option.match(() => Effect.succeed(false), (n) => Effect.succeed(n >= 10)))
      )
      const result = yield* $(
        pipe(
          [1, 3, 7, 20],
          Effect.forEach((n) =>
            pipe(
              Stream.range(1, 100),
              Stream.rechunk(n),
              Stream.run(sink),
              Effect.map((option) => Equal.equals(option, Option.some(Option.some(10))))
            )
          )
        )
      )
      assert.isTrue(pipe(result, Chunk.every(identity)))
    }))

  it.effect("findEffect - take sink across multiple chunks", () =>
    Effect.gen(function*($) {
      const sink = pipe(
        Sink.take<number>(4),
        Sink.findEffect((chunk) => Effect.succeed(pipe(chunk, Chunk.reduce(0, (x, y) => x + y)) > 10))
      )
      const result = yield* $(
        pipe(
          Stream.fromIterable(Chunk.range(1, 8)),
          Stream.rechunk(2),
          Stream.run(sink),
          Effect.map(Option.getOrElse(() => Chunk.empty<number>()))
        )
      )
      assert.deepStrictEqual(Array.from(result), [5, 6, 7, 8])
    }))

  it.effect("findEffect - empty stream terminates with none", () =>
    Effect.gen(function*($) {
      const sink = pipe(
        Sink.sum(),
        Sink.findEffect((n) => Effect.succeed(n > 0))
      )
      const result = yield* $(
        pipe(
          Stream.fromIterable([]),
          Stream.run(sink)
        )
      )
      assert.deepStrictEqual(result, Option.none())
    }))

  it.effect("findEffect - unsatisfied condition terminates with none", () =>
    Effect.gen(function*($) {
      const sink = pipe(
        Sink.head<number>(),
        Sink.findEffect(Option.match(() => Effect.succeed(false), (n) => Effect.succeed(n >= 3)))
      )
      const result = yield* $(
        pipe(
          Stream.fromIterable([1, 2]),
          Stream.run(sink)
        )
      )
      assert.deepStrictEqual(result, Option.none())
    }))

  it.effect("forEachWhile - handles leftovers", () =>
    Effect.gen(function*($) {
      const [result, value] = yield* $(
        pipe(
          Stream.range(1, 5),
          Stream.run(pipe(
            Sink.forEachWhile((n: number) => Effect.succeed(n <= 3)),
            Sink.collectLeftover
          ))
        )
      )
      assert.isUndefined(result)
      assert.deepStrictEqual(Array.from(value), [4])
    }))

  it.effect("splitWhere - should split a stream on a predicate and run each part into the sink", () =>
    Effect.gen(function*($) {
      const stream = Stream.make(1, 2, 3, 4, 5, 6, 7, 8)
      const result = yield* $(pipe(
        stream,
        Stream.transduce(pipe(Sink.collectAll<number>(), Sink.splitWhere((n) => n % 2 === 0))),
        Stream.runCollect
      ))
      assert.deepStrictEqual(
        Array.from(result).map((chunk) => Array.from(chunk)),
        [[1], [2, 3], [4, 5], [6, 7], [8]]
      )
    }))

  it.effect("splitWhere - should split a stream on a predicate and run each part into the sink, in several chunks", () =>
    Effect.gen(function*($) {
      const stream = Stream.fromChunks(Chunk.make(1, 2, 3, 4), Chunk.make(5, 6, 7, 8))
      const result = yield* $(pipe(
        stream,
        Stream.transduce(pipe(Sink.collectAll<number>(), Sink.splitWhere((n) => n % 2 === 0))),
        Stream.runCollect
      ))
      assert.deepStrictEqual(
        Array.from(result).map((chunk) => Array.from(chunk)),
        [[1], [2, 3], [4, 5], [6, 7], [8]]
      )
    }))

  it.effect("splitWhere - should not yield an empty sink if split on the first element", () =>
    Effect.gen(function*($) {
      const stream = Stream.make(1, 2, 3, 4, 5, 6, 7, 8)
      const result = yield* $(pipe(
        stream,
        Stream.transduce(pipe(Sink.collectAll<number>(), Sink.splitWhere((n) => n % 2 !== 0))),
        Stream.runCollect
      ))
      assert.deepStrictEqual(
        Array.from(result).map((chunk) => Array.from(chunk)),
        [[1, 2], [3, 4], [5, 6], [7, 8]]
      )
    }))
})
