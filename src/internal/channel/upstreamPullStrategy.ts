import { dual } from "@effect/data/Function"
import type * as Option from "@effect/data/Option"
import type * as UpstreamPullStrategy from "@effect/stream/Channel/UpstreamPullStrategy"
import * as OpCodes from "@effect/stream/internal/opCodes/upstreamPullStrategy"

/** @internal */
const UpstreamPullStrategySymbolKey = "@effect/stream/Channel/UpstreamPullStrategy"

/** @internal */
export const UpstreamPullStrategyTypeId: UpstreamPullStrategy.UpstreamPullStrategyTypeId = Symbol.for(
  UpstreamPullStrategySymbolKey
) as UpstreamPullStrategy.UpstreamPullStrategyTypeId

/** @internal */
const upstreamPullStrategyVariance = {
  _A: (_: never) => _
}

/** @internal */
const proto = {
  [UpstreamPullStrategyTypeId]: upstreamPullStrategyVariance
}

/** @internal */
export const PullAfterNext = <A>(emitSeparator: Option.Option<A>): UpstreamPullStrategy.UpstreamPullStrategy<A> => {
  const op = Object.create(proto)
  op._tag = OpCodes.OP_PULL_AFTER_NEXT
  op.emitSeparator = emitSeparator
  return op
}

/** @internal */
export const PullAfterAllEnqueued = <A>(
  emitSeparator: Option.Option<A>
): UpstreamPullStrategy.UpstreamPullStrategy<A> => {
  const op = Object.create(proto)
  op._tag = OpCodes.OP_PULL_AFTER_ALL_ENQUEUED
  op.emitSeparator = emitSeparator
  return op
}

/** @internal */
export const isUpstreamPullStrategy = (u: unknown): u is UpstreamPullStrategy.UpstreamPullStrategy<unknown> =>
  typeof u === "object" && u != null && UpstreamPullStrategyTypeId in u

/** @internal */
export const isPullAfterNext = <A>(
  self: UpstreamPullStrategy.UpstreamPullStrategy<A>
): self is UpstreamPullStrategy.PullAfterNext<A> => self._tag === OpCodes.OP_PULL_AFTER_NEXT

/** @internal */
export const isPullAfterAllEnqueued = <A>(
  self: UpstreamPullStrategy.UpstreamPullStrategy<A>
): self is UpstreamPullStrategy.PullAfterAllEnqueued<A> => self._tag === OpCodes.OP_PULL_AFTER_ALL_ENQUEUED

/** @internal */
export const match = dual<
  <A, Z>(
    onPullAfterNext: (emitSeparator: Option.Option<A>) => Z,
    onPullAfterAllEnqueued: (emitSeparator: Option.Option<A>) => Z
  ) => (self: UpstreamPullStrategy.UpstreamPullStrategy<A>) => Z,
  <A, Z>(
    self: UpstreamPullStrategy.UpstreamPullStrategy<A>,
    onPullAfterNext: (emitSeparator: Option.Option<A>) => Z,
    onPullAfterAllEnqueued: (emitSeparator: Option.Option<A>) => Z
  ) => Z
>(3, <A, Z>(
  self: UpstreamPullStrategy.UpstreamPullStrategy<A>,
  onPullAfterNext: (emitSeparator: Option.Option<A>) => Z,
  onPullAfterAllEnqueued: (emitSeparator: Option.Option<A>) => Z
): Z => {
  switch (self._tag) {
    case OpCodes.OP_PULL_AFTER_NEXT: {
      return onPullAfterNext(self.emitSeparator)
    }
    case OpCodes.OP_PULL_AFTER_ALL_ENQUEUED: {
      return onPullAfterAllEnqueued(self.emitSeparator)
    }
  }
})
