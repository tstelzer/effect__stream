import * as Chunk from "@effect/data/Chunk"
import * as Equal from "@effect/data/Equal"
import { pipe } from "@effect/data/Function"
import * as Hash from "@effect/data/Hash"
import * as HashSet from "@effect/data/HashSet"
import * as Option from "@effect/data/Option"
import * as ReadonlyArray from "@effect/data/ReadonlyArray"
import * as Effect from "@effect/io/Effect"
import * as Random from "@effect/io/Random"
import * as Ref from "@effect/io/Ref"
import * as Channel from "@effect/stream/Channel"
import * as MergeDecision from "@effect/stream/Channel/MergeDecision"
import * as it from "@effect/stream/test/utils/extend"
import { assert, describe } from "vitest"

export const mapper = <A, B>(
  f: (a: A) => B
): Channel.Channel<never, unknown, A, unknown, never, B, void> => {
  return Channel.readWith(
    (a: A) =>
      pipe(
        Channel.write(f(a)),
        Channel.flatMap(() => mapper(f))
      ),
    Channel.unit,
    Channel.unit
  )
}

export const refWriter = <A>(
  ref: Ref.Ref<ReadonlyArray<A>>
): Channel.Channel<never, unknown, A, unknown, never, never, void> => {
  return Channel.readWith(
    (a: A) =>
      pipe(
        Channel.fromEffect(pipe(Ref.update(ref, ReadonlyArray.prepend(a)), Effect.asUnit)),
        Channel.flatMap(() => refWriter(ref))
      ),
    Channel.unit,
    Channel.unit
  )
}

export const refReader = <A>(
  ref: Ref.Ref<ReadonlyArray<A>>
): Channel.Channel<never, unknown, unknown, unknown, never, A, void> => {
  return pipe(
    Channel.fromEffect(
      Ref.modify(ref, (array) => {
        if (ReadonlyArray.isEmptyReadonlyArray(array)) {
          return [Option.none(), ReadonlyArray.empty<A>()] as const
        }
        return [Option.some(array[0]!), array.slice(1)] as const
      })
    ),
    Channel.flatMap(Option.match(Channel.unit, (i) => pipe(Channel.write(i), Channel.flatMap(() => refReader(ref)))))
  )
}

describe.concurrent("Channel", () => {
  it.effect("simple reads", () =>
    Effect.gen(function*($) {
      class Whatever implements Equal.Equal {
        constructor(readonly i: number) {}
        [Hash.symbol](): number {
          return Hash.hash(this.i)
        }
        [Equal.symbol](u: unknown): boolean {
          return u instanceof Whatever && u.i === this.i
        }
      }
      const left = Channel.writeAll(1, 2, 3)
      const right = pipe(
        Channel.read<number>(),
        Channel.catchAll(() => Channel.succeed(4)),
        Channel.flatMap((i) => Channel.write(new Whatever(i)))
      )
      const channel = pipe(
        left,
        Channel.pipeTo(
          pipe(
            right,
            Channel.zipRight(right),
            Channel.zipRight(right),
            Channel.zipRight(right)
          )
        )
      )
      const result = yield* $(Channel.runCollect(channel))
      const [chunk, value] = result
      assert.deepStrictEqual(Array.from(chunk), [
        new Whatever(1),
        new Whatever(2),
        new Whatever(3),
        new Whatever(4)
      ])
      assert.isUndefined(value)
    }))

  it.effect("read pipelining", () =>
    Effect.gen(function*($) {
      const innerChannel = pipe(
        Channel.fromEffect(Ref.make<ReadonlyArray<number>>([])),
        Channel.flatMap((ref) => {
          const inner = (): Channel.Channel<never, unknown, number, unknown, never, number, void> =>
            Channel.readWith(
              (input: number) =>
                pipe(
                  Channel.fromEffect(Ref.update(ref, (array) => [...array, input])),
                  Channel.zipRight(Channel.write(input)),
                  Channel.flatMap(inner)
                ),
              Channel.unit,
              Channel.unit
            )
          return pipe(
            inner(),
            Channel.zipRight(Channel.fromEffect(Ref.get(ref)))
          )
        })
      )
      const f = (n: number) => n
      const g = (n: number) => [n, n]
      const channel = pipe(
        Channel.writeAll(1, 2),
        Channel.pipeTo(mapper(f)),
        Channel.pipeTo(pipe(mapper(g), Channel.concatMap((ns) => Channel.writeAll(...ns)), Channel.asUnit)),
        Channel.pipeTo(innerChannel)
      )
      const [chunk, list] = yield* $(Channel.runCollect(channel))
      assert.deepStrictEqual(Array.from(chunk), [1, 1, 2, 2])
      assert.deepStrictEqual(Array.from(list), [1, 1, 2, 2])
    }))

  it.effect("read pipelining 2", () =>
    Effect.gen(function*($) {
      const ref = yield* $(Ref.make<ReadonlyArray<number>>([]))
      const intProducer: Channel.Channel<
        never,
        unknown,
        unknown,
        unknown,
        never,
        number,
        void
      > = Channel.writeAll(1, 2, 3, 4, 5)
      const readIntsN = (
        n: number
      ): Channel.Channel<never, unknown, number, unknown, never, number, string> =>
        n > 0
          ? Channel.readWith(
            (i: number) => pipe(Channel.write(i), Channel.flatMap(() => readIntsN(n - 1))),
            () => Channel.succeed("EOF"),
            () => Channel.succeed("EOF")
          )
          : Channel.succeed("end")

      const sum = (
        label: string,
        n: number
      ): Channel.Channel<never, unknown, number, unknown, unknown, never, void> =>
        Channel.readWith(
          (input: number) => sum(label, n + input),
          () => Channel.fromEffect(Ref.update(ref, (array) => [...array, n])),
          () => Channel.fromEffect(Ref.update(ref, (array) => [...array, n]))
        )

      const channel = pipe(
        intProducer,
        Channel.pipeTo(
          pipe(
            readIntsN(2),
            Channel.pipeTo(sum("left", 0)),
            Channel.zipRight(readIntsN(2)),
            Channel.pipeTo(sum("right", 0))
          )
        )
      )
      const result = yield* $(pipe(Channel.run(channel), Effect.zipRight(Ref.get(ref))))
      assert.deepStrictEqual(result, [3, 7])
    }))

  it.effect("reading with resources", () =>
    Effect.gen(function*($) {
      const ref = yield* $(Ref.make<ReadonlyArray<string>>([]))
      const event = (label: string) => Ref.update(ref, (array) => [...array, label])
      const left = pipe(
        Channel.acquireReleaseOut(
          event("Acquire outer"),
          () => event("Release outer")
        ),
        Channel.concatMap(
          () =>
            pipe(
              Channel.writeAll(1, 2, 3),
              Channel.concatMap((i) =>
                Channel.acquireReleaseOut(
                  pipe(event(`Acquire ${i}`), Effect.as(i)),
                  () => event(`Release ${i}`)
                )
              )
            )
        )
      )
      const read = pipe(
        Channel.read<number>(),
        Channel.mapEffect((i) => event(`Read ${i}`)),
        Channel.asUnit
      )
      const right = pipe(
        read,
        Channel.zipRight(read),
        Channel.catchAll(() => Channel.unit())
      )
      const channel = pipe(left, Channel.pipeTo(right))
      const result = yield* $(pipe(Channel.runDrain(channel), Effect.zipRight(Ref.get(ref))))
      assert.deepStrictEqual(Array.from(result), [
        "Acquire outer",
        "Acquire 1",
        "Read 1",
        "Release 1",
        "Acquire 2",
        "Read 2",
        "Release 2",
        "Release outer"
      ])
    }))

  it.effect("simple concurrent reads", () =>
    Effect.gen(function*($) {
      const capacity = 128
      const elements = yield* $(Effect.collectAll(Array.from({ length: capacity }, () => Random.nextInt())))
      const source = yield* $(Ref.make(ReadonlyArray.fromIterable(elements)))
      const destination = yield* $(Ref.make<ReadonlyArray<number>>([]))
      const twoWriters = pipe(
        refWriter(destination),
        Channel.mergeWith(
          refWriter(destination),
          () => MergeDecision.AwaitConst(Effect.unit()),
          () => MergeDecision.AwaitConst(Effect.unit())
        )
      )
      const [missing, surplus] = yield* $(
        pipe(
          refReader(source),
          Channel.pipeTo(twoWriters),
          Channel.mapEffect(() => Ref.get(destination)),
          Channel.run,
          Effect.map((result) => {
            let missing = HashSet.fromIterable(elements)
            let surplus = HashSet.fromIterable(result)
            for (const value of result) {
              missing = pipe(missing, HashSet.remove(value))
            }
            for (const value of elements) {
              surplus = pipe(surplus, HashSet.remove(value))
            }
            return [missing, surplus] as const
          })
        )
      )

      assert.strictEqual(HashSet.size(missing), 0)
      assert.strictEqual(HashSet.size(surplus), 0)
    }))

  it.effect("nested concurrent reads", () =>
    Effect.gen(function*($) {
      const capacity = 128
      const f = (n: number) => n + 1
      const elements = yield* $(Effect.collectAll(Array.from({ length: capacity }, () => Random.nextInt())))
      const source = yield* $(Ref.make(ReadonlyArray.fromIterable(elements)))
      const destination = yield* $(Ref.make<ReadonlyArray<number>>([]))
      const twoWriters = pipe(
        mapper(f),
        Channel.pipeTo(refWriter(destination)),
        Channel.mergeWith(
          pipe(mapper(f), Channel.pipeTo(refWriter(destination))),
          () => MergeDecision.AwaitConst(Effect.unit()),
          () => MergeDecision.AwaitConst(Effect.unit())
        )
      )
      const [missing, surplus] = yield* $(
        pipe(
          refReader(source),
          Channel.pipeTo(twoWriters),
          Channel.mapEffect(() => Ref.get(destination)),
          Channel.run,
          Effect.map((result) => {
            const expected = HashSet.fromIterable(pipe(elements, Chunk.map(f)))
            let missing = HashSet.fromIterable(expected)
            let surplus = HashSet.fromIterable(result)
            for (const value of result) {
              missing = pipe(missing, HashSet.remove(value))
            }
            for (const value of expected) {
              surplus = pipe(surplus, HashSet.remove(value))
            }
            return [missing, surplus] as const
          })
        )
      )
      assert.strictEqual(HashSet.size(missing), 0)
      assert.strictEqual(HashSet.size(surplus), 0)
    }))
})
