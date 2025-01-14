import * as Chunk from "@effect/data/Chunk"
import { pipe } from "@effect/data/Function"
import * as ReadonlyArray from "@effect/data/ReadonlyArray"
import * as Effect from "@effect/io/Effect"
import * as Stream from "@effect/stream/Stream"
import * as it from "@effect/stream/test/utils/extend"
import { assert, describe } from "vitest"

describe.concurrent("Stream", () => {
  it.effect("scan", () =>
    Effect.gen(function*($) {
      const stream = Stream.make(1, 2, 3, 4, 5)
      const { result1, result2 } = yield* $(Effect.struct({
        result1: pipe(stream, Stream.scan(0, (acc, curr) => acc + curr), Stream.runCollect),
        result2: pipe(
          Stream.runCollect(stream),
          Effect.map((chunk) =>
            pipe(
              Chunk.toReadonlyArray(chunk),
              ReadonlyArray.scan(0, (acc, curr) => acc + curr)
            )
          )
        )
      }))
      assert.deepStrictEqual(Array.from(result1), Array.from(result2))
    }))

  it.effect("scanReduce", () =>
    Effect.gen(function*($) {
      const stream = Stream.make(1, 2, 3, 4, 5)
      const result = yield* $(pipe(
        stream,
        Stream.scanReduce<number, number>((acc, curr) => acc + curr),
        Stream.runCollect
      ))
      assert.deepStrictEqual(Array.from(result), [1, 3, 6, 10, 15])
    }))
})
