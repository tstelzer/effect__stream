import * as Chunk from "@effect/data/Chunk"
import * as Either from "@effect/data/Either"
import { pipe } from "@effect/data/Function"
import * as Option from "@effect/data/Option"
import * as Cause from "@effect/io/Cause"
import * as Effect from "@effect/io/Effect"
import * as Exit from "@effect/io/Exit"
import * as Ref from "@effect/io/Ref"
import * as Stream from "@effect/stream/Stream"
import * as it from "@effect/stream/test/utils/extend"
import { assert, describe } from "vitest"

describe.concurrent("Stream", () => {
  it.effect("absolve - happy path", () =>
    Effect.gen(function*($) {
      const chunk = Chunk.range(1, 10)
      const result = yield* $(
        pipe(
          chunk,
          Chunk.map(Either.right),
          Stream.fromIterable,
          Stream.absolve,
          Stream.runCollect
        )
      )
      assert.deepStrictEqual(Array.from(result), Array.from(chunk))
    }))

  it.effect("absolve - failure", () =>
    Effect.gen(function*($) {
      const result = yield* $(
        pipe(
          Stream.fromIterable(pipe(Chunk.range(1, 10), Chunk.map(Either.right))),
          Stream.concat(Stream.succeed(Either.left("Ouch"))),
          Stream.absolve,
          Stream.runCollect,
          Effect.exit
        )
      )
      assert.deepStrictEqual(Exit.unannotate(result), Exit.fail("Ouch"))
    }))

  it.effect("absolve - round trip #1", () =>
    Effect.gen(function*($) {
      const xss = Stream.fromIterable(pipe(Chunk.range(1, 10), Chunk.map(Either.right)))
      const stream = pipe(xss, Stream.concat(Stream.succeed(Either.left("Ouch"))), Stream.concat(xss))
      const { result1, result2 } = yield* $(Effect.struct({
        result1: Stream.runCollect(stream),
        result2: pipe(Stream.absolve(stream), Stream.either, Stream.runCollect)
      }))
      assert.deepStrictEqual(
        Array.from(pipe(result1, Chunk.take(result2.length))),
        Array.from(result2)
      )
    }))

  it.effect("absolve - round trip #2", () =>
    Effect.gen(function*($) {
      const xss = Stream.fromIterable(pipe(Chunk.range(1, 10), Chunk.map(Either.right)))
      const stream = pipe(xss, Stream.concat(Stream.fail("Ouch")))
      const { result1, result2 } = yield* $(Effect.struct({
        result1: Effect.exit(Stream.runCollect(stream)),
        result2: pipe(stream, Stream.either, Stream.absolve, Stream.runCollect, Effect.exit)
      }))
      assert.deepStrictEqual(Exit.unannotate(result1), Exit.fail("Ouch"))
      assert.deepStrictEqual(Exit.unannotate(result2), Exit.fail("Ouch"))
    }))

  it.effect("catchAllCause - recovery from errors", () =>
    Effect.gen(function*($) {
      const stream1 = pipe(Stream.make(1, 2), Stream.concat(Stream.fail("boom")))
      const stream2 = Stream.make(3, 4)
      const result = yield* $(pipe(
        stream1,
        Stream.catchAllCause(() => stream2),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1, 2, 3, 4])
    }))

  it.effect("catchAllCause - recovery from defects", () =>
    Effect.gen(function*($) {
      const stream1 = pipe(Stream.make(1, 2), Stream.concat(Stream.dieMessage("boom")))
      const stream2 = Stream.make(3, 4)
      const result = yield* $(pipe(
        stream1,
        Stream.catchAllCause(() => stream2),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1, 2, 3, 4])
    }))

  it.effect("catchAllCause - happy path", () =>
    Effect.gen(function*($) {
      const stream1 = Stream.make(1, 2)
      const stream2 = Stream.make(3, 4)
      const result = yield* $(pipe(
        stream1,
        Stream.catchAllCause(() => stream2),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1, 2])
    }))

  it.effect("catchAllCause - executes finalizers", () =>
    Effect.gen(function*($) {
      const ref = yield* $(Ref.make(Chunk.empty<string>()))
      const stream1 = pipe(
        Stream.make(1, 2),
        Stream.concat(Stream.fail("boom")),
        Stream.ensuring(Ref.update(ref, Chunk.append("s1")))
      )
      const stream2 = pipe(
        Stream.make(1, 2),
        Stream.concat(Stream.fail("boom")),
        Stream.ensuring(Ref.update(ref, Chunk.append("s2")))
      )
      yield* $(pipe(
        stream1,
        Stream.catchAllCause(() => stream2),
        Stream.runCollect,
        Effect.exit
      ))
      const result = yield* $(Ref.get(ref))
      assert.deepStrictEqual(Array.from(result), ["s1", "s2"])
    }))

  it.effect("catchAllCause - releases all resources by the time the failover stream has started", () =>
    Effect.gen(function*($) {
      const ref = yield* $(Ref.make(Chunk.empty<number>()))
      const stream = pipe(
        Stream.finalizer(Ref.update(ref, Chunk.append(1))),
        Stream.crossRight(Stream.finalizer(Ref.update(ref, Chunk.append(2)))),
        Stream.crossRight(Stream.finalizer(Ref.update(ref, Chunk.append(3)))),
        Stream.crossRight(Stream.fail("boom"))
      )
      const result = yield* $(pipe(
        Stream.drain(stream),
        Stream.catchAllCause(() => Stream.fromEffect(Ref.get(ref))),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(Chunk.flatten(result)), [3, 2, 1])
    }))

  it.effect("catchAllCause - propagates the right Exit value to the failing stream (ZIO #3609)", () =>
    Effect.gen(function*($) {
      const ref = yield* $(Ref.make<Exit.Exit<unknown, unknown>>(Exit.unit()))
      yield* $(pipe(
        Stream.acquireRelease(
          Effect.unit(),
          (_, exit) => Ref.set(ref, exit)
        ),
        Stream.flatMap(() => Stream.fail("boom")),
        Stream.either,
        Stream.runDrain,
        Effect.exit
      ))
      const result = yield* $(Ref.get(ref))
      assert.deepStrictEqual(Exit.unannotate(result), Exit.fail("boom"))
    }))

  it.effect("catchSome - recovery from some errors", () =>
    Effect.gen(function*($) {
      const stream1 = pipe(
        Stream.make(1, 2),
        Stream.concat(Stream.fail("boom"))
      )
      const stream2 = Stream.make(3, 4)
      const result = yield* $(pipe(
        stream1,
        Stream.catchSome((error) => error === "boom" ? Option.some(stream2) : Option.none()),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1, 2, 3, 4])
    }))

  it.effect("catchSome - fails stream when partial function does not match", () =>
    Effect.gen(function*($) {
      const stream1 = pipe(
        Stream.make(1, 2),
        Stream.concat(Stream.fail("boom"))
      )
      const stream2 = Stream.make(3, 4)
      const result = yield* $(pipe(
        stream1,
        Stream.catchSome((error) => error === "boomer" ? Option.some(stream2) : Option.none()),
        Stream.runCollect,
        Effect.either
      ))
      assert.deepStrictEqual(result, Either.left("boom"))
    }))

  it.effect("catchSomeCause - recovery from some errors", () =>
    Effect.gen(function*($) {
      const stream1 = pipe(
        Stream.make(1, 2),
        Stream.concat(Stream.failCause(Cause.fail("boom")))
      )
      const stream2 = Stream.make(3, 4)
      const result = yield* $(pipe(
        stream1,
        Stream.catchSomeCause((annotatedCause) => {
          const cause = Cause.unannotate(annotatedCause)
          return Cause.isFailType(cause) && cause.error === "boom" ?
            Option.some(stream2) :
            Option.none()
        }),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1, 2, 3, 4])
    }))

  it.effect("catchSomeCause - fails stream when partial function does not match", () =>
    Effect.gen(function*($) {
      const stream1 = pipe(
        Stream.make(1, 2),
        Stream.concat(Stream.fail("boom"))
      )
      const stream2 = Stream.make(3, 4)
      const result = yield* $(pipe(
        stream1,
        Stream.catchSomeCause((cause) =>
          Cause.isEmpty(cause) ?
            Option.some(stream2) :
            Option.none()
        ),
        Stream.runCollect,
        Effect.either
      ))
      assert.deepStrictEqual(result, Either.left("boom"))
    }))

  it.effect("onError", () =>
    Effect.gen(function*($) {
      const ref = yield* $(Ref.make(false))
      const exit = yield* $(pipe(
        Stream.fail("boom"),
        Stream.onError(() => Ref.set(ref, true)),
        Stream.runDrain,
        Effect.exit
      ))
      const called = yield* $(Ref.get(ref))
      assert.deepStrictEqual(Exit.unannotate(exit), Exit.fail("boom"))
      assert.isTrue(called)
    }))

  it.effect("orElse", () =>
    Effect.gen(function*($) {
      const stream1 = pipe(
        Stream.make(1, 2, 3),
        Stream.concat(Stream.fail("boom"))
      )
      const stream2 = Stream.make(4, 5, 6)
      const result = yield* $(pipe(
        stream1,
        Stream.orElse(() => stream2),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1, 2, 3, 4, 5, 6])
    }))

  it.effect("orElseEither", () =>
    Effect.gen(function*($) {
      const stream1 = pipe(
        Stream.make(1),
        Stream.concat(Stream.fail("boom"))
      )
      const stream2 = Stream.make(2)
      const result = yield* $(pipe(
        stream1,
        Stream.orElseEither(() => stream2),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [Either.left(1), Either.right(2)])
    }))

  it.effect("orElseFail", () =>
    Effect.gen(function*($) {
      const stream = pipe(Stream.succeed(1), Stream.concat(Stream.fail("boom")))
      const result = yield* $(pipe(
        stream,
        Stream.orElseFail(() => "boomer"),
        Stream.runCollect,
        Effect.either
      ))
      assert.deepStrictEqual(result, Either.left("boomer"))
    }))

  it.effect("orElseIfEmpty - produce default value if stream is empty", () =>
    Effect.gen(function*($) {
      const result = yield* $(pipe(
        Stream.empty,
        Stream.orElseIfEmpty(() => 0),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [0])
    }))

  it.effect("orElseIfEmpty - ignores default value when stream is not empty", () =>
    Effect.gen(function*($) {
      const result = yield* $(pipe(
        Stream.make(1),
        Stream.orElseIfEmpty(() => 0),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1])
    }))

  it.effect("orElseIfEmptyStream - consume default stream if stream is empty", () =>
    Effect.gen(function*($) {
      const result = yield* $(pipe(
        Stream.empty,
        Stream.orElseIfEmptyStream(() => Stream.range(0, 5)),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [0, 1, 2, 3, 4])
    }))

  it.effect("orElseIfEmptyStream - should throw the correct error from the default stream", () =>
    Effect.gen(function*($) {
      const result = yield* $(pipe(
        Stream.empty,
        Stream.orElseIfEmptyStream(() => Stream.fail("Ouch")),
        Stream.runCollect,
        Effect.either
      ))
      assert.deepStrictEqual(result, Either.left("Ouch"))
    }))

  it.effect("orElseOptional", () =>
    Effect.gen(function*($) {
      const stream1 = pipe(Stream.succeed(1), Stream.concat(Stream.fail(Option.none())))
      const stream2 = Stream.succeed(2)
      const result = yield* $(pipe(
        stream1,
        Stream.orElseOptional(() => stream2),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1, 2])
    }))

  it.effect("orElseSucceed", () =>
    Effect.gen(function*($) {
      const stream = pipe(Stream.succeed(1), Stream.concat(Stream.fail("boom")))
      const result = yield* $(pipe(
        stream,
        Stream.orElseSucceed(() => 2),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1, 2])
    }))
})
