import * as Chunk from "@effect/data/Chunk"
import * as Either from "@effect/data/Either"
import { pipe } from "@effect/data/Function"
import * as Cause from "@effect/io/Cause"
import * as Deferred from "@effect/io/Deferred"
import * as Effect from "@effect/io/Effect"
import * as Exit from "@effect/io/Exit"
import * as Ref from "@effect/io/Ref"
import * as Stream from "@effect/stream/Stream"
import * as it from "@effect/stream/test/utils/extend"
import { assert, describe } from "vitest"

describe.concurrent("Stream", () => {
  it.effect("drain - simple example", () =>
    Effect.gen(function*($) {
      const ref = yield* $(Ref.make(Chunk.empty<number>()))
      yield* $(pipe(
        Stream.range(0, 10),
        Stream.mapEffect((n) => Ref.update(ref, Chunk.append(n))),
        Stream.drain,
        Stream.runDrain
      ))
      const result = yield* $(Ref.get(ref))
      assert.deepStrictEqual(Array.from(result), Array.from(Chunk.range(0, 9)))
    }))

  it.effect("drain - is not too eager", () =>
    Effect.gen(function*($) {
      const ref = yield* $(Ref.make(0))
      const result1 = yield* $(pipe(
        Stream.make(1),
        Stream.tap((n) => Ref.set(ref, n)),
        Stream.concat(Stream.fail("fail")),
        Stream.runDrain,
        Effect.either
      ))
      const result2 = yield* $(Ref.get(ref))
      assert.deepStrictEqual(result1, Either.left("fail"))
      assert.strictEqual(result2, 1)
    }))

  it.effect("drainFork - runs the other stream in the background", () =>
    Effect.gen(function*($) {
      const latch = yield* $(Deferred.make<never, void>())
      const result = yield* $(pipe(
        Stream.fromEffect(Deferred.await(latch)),
        Stream.drainFork(Stream.fromEffect(Deferred.succeed<never, void>(latch, void 0))),
        Stream.runDrain
      ))
      assert.isUndefined(result)
    }))

  it.effect("drainFork - interrupts the background stream when the foreground exits", () =>
    Effect.gen(function*($) {
      const ref = yield* $(Ref.make(false))
      const latch = yield* $(Deferred.make<never, void>())
      yield* $(pipe(
        Stream.make(1, 2, 3),
        Stream.concat(Stream.drain(Stream.fromEffect(Deferred.await(latch)))),
        Stream.drainFork(
          pipe(
            Deferred.succeed<never, void>(latch, void 0),
            Effect.zipRight(Effect.never()),
            Effect.onInterrupt(() => Ref.set(ref, true)),
            Stream.fromEffect
          )
        ),
        Stream.runDrain
      ))
      const result = yield* $(Ref.get(ref))
      assert.isTrue(result)
    }))

  it.effect("drainFork - fails the foreground stream if the background fails with a typed error", () =>
    Effect.gen(function*($) {
      const result = yield* $(pipe(
        Stream.never(),
        Stream.drainFork(Stream.fail("boom")),
        Stream.runDrain,
        Effect.exit
      ))
      assert.deepStrictEqual(Exit.unannotate(result), Exit.fail("boom"))
    }))

  it.effect("drainFork - fails the foreground stream if the background fails with a defect", () =>
    Effect.gen(function*($) {
      const error = Cause.RuntimeException("boom")
      const result = yield* $(pipe(
        Stream.never(),
        Stream.drainFork(Stream.die(error)),
        Stream.runDrain,
        Effect.exit
      ))
      assert.deepStrictEqual(Exit.unannotate(result), Exit.die(error))
    }))
})
