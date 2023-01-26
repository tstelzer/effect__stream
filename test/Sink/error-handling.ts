import * as Effect from "@effect/io/Effect"
import * as Exit from "@effect/io/Exit"
import * as Sink from "@effect/stream/Sink"
import * as Stream from "@effect/stream/Stream"
import * as it from "@effect/stream/test/utils/extend"
import { pipe } from "@fp-ts/core/Function"
import { assert, describe } from "vitest"

describe.concurrent("Sink", () => {
  it.effect("propagates errors", () =>
    Effect.gen(function*($) {
      const ErrorStream = "ErrorStream" as const
      const ErrorMapped = "ErrorMapped" as const
      const ErrorSink = "ErrorSink" as const
      const result = yield* $(
        pipe(
          Stream.fail(ErrorStream),
          Stream.mapError(() => ErrorMapped),
          Stream.run(
            pipe(
              Sink.drain(),
              Sink.contramapEffect((input: number) => Effect.attempt(() => input)),
              Sink.mapError(() => ErrorSink)
            )
          ),
          Effect.exit
        )
      )
      assert.deepStrictEqual(Exit.unannotate(result), Exit.fail(ErrorMapped))
    }))
})
