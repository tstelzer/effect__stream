import type * as Either from "@effect/data/Either"
import { dual } from "@effect/data/Function"
import type * as Effect from "@effect/io/Effect"
import type * as Exit from "@effect/io/Exit"
import type * as Fiber from "@effect/io/Fiber"
import type * as MergeState from "@effect/stream/Channel/MergeState"
import * as OpCodes from "@effect/stream/internal/opCodes/mergeState"

/** @internal */
const MergeStateSymbolKey = "@effect/stream/Channel/MergeState"

/** @internal */
export const MergeStateTypeId: MergeState.MergeStateTypeId = Symbol.for(
  MergeStateSymbolKey
) as MergeState.MergeStateTypeId

/** @internal */
const proto = {
  [MergeStateTypeId]: MergeStateTypeId
}

/** @internal */
export const BothRunning = <Env, Err, Err1, Err2, Elem, Done, Done1, Done2>(
  left: Fiber.Fiber<Err, Either.Either<Done, Elem>>,
  right: Fiber.Fiber<Err1, Either.Either<Done1, Elem>>
): MergeState.MergeState<Env, Err, Err1, Err2, Elem, Done, Done1, Done2> => {
  const op = Object.create(proto)
  op._tag = OpCodes.OP_BOTH_RUNNING
  op.left = left
  op.right = right
  return op
}

/** @internal */
export const LeftDone = <Env, Err, Err1, Err2, Elem, Done, Done1, Done2>(
  f: (exit: Exit.Exit<Err1, Done1>) => Effect.Effect<Env, Err2, Done2>
): MergeState.MergeState<Env, Err, Err1, Err2, Elem, Done, Done1, Done2> => {
  const op = Object.create(proto)
  op._tag = OpCodes.OP_LEFT_DONE
  op.f = f
  return op
}

/** @internal */
export const RightDone = <Env, Err, Err1, Err2, Elem, Done, Done1, Done2>(
  f: (exit: Exit.Exit<Err, Done>) => Effect.Effect<Env, Err2, Done2>
): MergeState.MergeState<Env, Err, Err1, Err2, Elem, Done, Done1, Done2> => {
  const op = Object.create(proto)
  op._tag = OpCodes.OP_RIGHT_DONE
  op.f = f
  return op
}

/** @internal */
export const isMergeState = (
  u: unknown
): u is MergeState.MergeState<unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown> => {
  return typeof u === "object" && u != null && MergeStateTypeId in u
}

/** @internal */
export const isBothRunning = <Env, Err, Err1, Err2, Elem, Done, Done1, Done2>(
  self: MergeState.MergeState<Env, Err, Err1, Err2, Elem, Done, Done1, Done2>
): self is MergeState.BothRunning<Env, Err, Err1, Err2, Elem, Done, Done1, Done2> => {
  return self._tag === OpCodes.OP_BOTH_RUNNING
}

/** @internal */
export const isLeftDone = <Env, Err, Err1, Err2, Elem, Done, Done1, Done2>(
  self: MergeState.MergeState<Env, Err, Err1, Err2, Elem, Done, Done1, Done2>
): self is MergeState.LeftDone<Env, Err, Err1, Err2, Elem, Done, Done1, Done2> => {
  return self._tag === OpCodes.OP_LEFT_DONE
}

/** @internal */
export const isRightDone = <Env, Err, Err1, Err2, Elem, Done, Done1, Done2>(
  self: MergeState.MergeState<Env, Err, Err1, Err2, Elem, Done, Done1, Done2>
): self is MergeState.RightDone<Env, Err, Err1, Err2, Elem, Done, Done1, Done2> => {
  return self._tag === OpCodes.OP_RIGHT_DONE
}

/** @internal */
export const match = dual<
  <Env, Err, Err1, Err2, Elem, Done, Done1, Done2, Z>(
    onBothRunning: (
      left: Fiber.Fiber<Err, Either.Either<Done, Elem>>,
      right: Fiber.Fiber<Err1, Either.Either<Done1, Elem>>
    ) => Z,
    onLeftDone: (f: (exit: Exit.Exit<Err1, Done1>) => Effect.Effect<Env, Err2, Done2>) => Z,
    onRightDone: (f: (exit: Exit.Exit<Err, Done>) => Effect.Effect<Env, Err2, Done2>) => Z
  ) => (self: MergeState.MergeState<Env, Err, Err1, Err2, Elem, Done, Done1, Done2>) => Z,
  <Env, Err, Err1, Err2, Elem, Done, Done1, Done2, Z>(
    self: MergeState.MergeState<Env, Err, Err1, Err2, Elem, Done, Done1, Done2>,
    onBothRunning: (
      left: Fiber.Fiber<Err, Either.Either<Done, Elem>>,
      right: Fiber.Fiber<Err1, Either.Either<Done1, Elem>>
    ) => Z,
    onLeftDone: (f: (exit: Exit.Exit<Err1, Done1>) => Effect.Effect<Env, Err2, Done2>) => Z,
    onRightDone: (f: (exit: Exit.Exit<Err, Done>) => Effect.Effect<Env, Err2, Done2>) => Z
  ) => Z
>(4, (
  self,
  onBothRunning,
  onLeftDone,
  onRightDone
) => {
  switch (self._tag) {
    case OpCodes.OP_BOTH_RUNNING: {
      return onBothRunning(self.left, self.right)
    }
    case OpCodes.OP_LEFT_DONE: {
      return onLeftDone(self.f)
    }
    case OpCodes.OP_RIGHT_DONE: {
      return onRightDone(self.f)
    }
  }
})
