import * as Chunk from "@effect/data/Chunk"
import type * as Context from "@effect/data/Context"
import { identity, pipe } from "@effect/data/Function"
import * as MRef from "@effect/data/MutableRef"
import * as Option from "@effect/data/Option"
import * as Cause from "@effect/io/Cause"
import * as Debug from "@effect/io/Debug"
import * as Deferred from "@effect/io/Deferred"
import * as Effect from "@effect/io/Effect"
import * as ExecutionStrategy from "@effect/io/ExecutionStrategy"
import * as Exit from "@effect/io/Exit"
import * as Fiber from "@effect/io/Fiber"
import * as Scope from "@effect/io/Scope"
import type * as Channel from "@effect/stream/Channel"
import type * as ChildExecutorDecision from "@effect/stream/Channel/ChildExecutorDecision"
import type * as UpstreamPullStrategy from "@effect/stream/Channel/UpstreamPullStrategy"
import * as ChannelState from "@effect/stream/internal/channel/channelState"
import * as Continuation from "@effect/stream/internal/channel/continuation"
import * as Subexecutor from "@effect/stream/internal/channel/subexecutor"
import * as upstreamPullRequest from "@effect/stream/internal/channel/upstreamPullRequest"
import * as core from "@effect/stream/internal/core"
import * as ChannelOpCodes from "@effect/stream/internal/opCodes/channel"
import * as ChannelStateOpCodes from "@effect/stream/internal/opCodes/channelState"
import * as ChildExecutorDecisionOpCodes from "@effect/stream/internal/opCodes/childExecutorDecision"
import * as ContinuationOpCodes from "@effect/stream/internal/opCodes/continuation"
import * as UpstreamPullStrategyOpCodes from "@effect/stream/internal/opCodes/upstreamPullStrategy"

export type ErasedChannel<R> = Channel.Channel<
  R,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
>

/** @internal */
export type ErasedExecutor<R> = ChannelExecutor<
  R,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
>

/** @internal */
export type ErasedContinuation<R> = Continuation.Continuation<
  R,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
>

/** @internal */
export type ErasedFinalizer<R> = (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<R, never, unknown>

export class ChannelExecutor<Env, InErr, InElem, InDone, OutErr, OutElem, OutDone> {
  private _activeSubexecutor: Subexecutor.Subexecutor<Env> | undefined = undefined

  private _cancelled: Exit.Exit<OutErr, OutDone> | undefined = undefined

  private _closeLastSubstream: Effect.Effect<Env, never, unknown> | undefined = undefined

  private _currentChannel: core.Primitive | undefined

  private _done: Exit.Exit<unknown, unknown> | undefined = undefined

  private _doneStack: Array<ErasedContinuation<Env>> = []

  private _emitted: unknown | undefined = undefined

  private _traceStack: Array<Debug.SourceLocation> = []

  private _executeCloseLastSubstream: (
    effect: Effect.Effect<Env, never, unknown>
  ) => Effect.Effect<Env, never, unknown>

  private _input: ErasedExecutor<Env> | undefined = undefined

  private _inProgressFinalizer: Effect.Effect<Env, never, unknown> | undefined = undefined

  private _providedEnv: Context.Context<unknown> | undefined

  constructor(
    initialChannel: Channel.Channel<Env, InErr, InElem, InDone, OutErr, OutElem, OutDone>,
    providedEnv: Context.Context<unknown> | undefined,
    executeCloseLastSubstream: (effect: Effect.Effect<Env, never, unknown>) => Effect.Effect<Env, never, unknown>
  ) {
    this._currentChannel = initialChannel as core.Primitive
    this._executeCloseLastSubstream = executeCloseLastSubstream
    this._providedEnv = providedEnv
  }

  run(): ChannelState.ChannelState<Env, unknown> {
    let result: ChannelState.ChannelState<Env, unknown> | undefined = undefined
    while (result === undefined) {
      if (this._cancelled !== undefined) {
        result = this.processCancellation()
      } else if (this._activeSubexecutor !== undefined) {
        result = this.runSubexecutor()
      } else {
        try {
          if (this._currentChannel === undefined) {
            result = ChannelState.Done()
          } else {
            switch (this._currentChannel._tag) {
              case ChannelOpCodes.OP_BRACKET_OUT: {
                result = this.runBracketOut(this._currentChannel)
                break
              }

              case ChannelOpCodes.OP_BRIDGE: {
                const bridgeInput = this._currentChannel.input

                // PipeTo(left, Bridge(queue, channel))
                // In a fiber: repeatedly run left and push its outputs to the queue
                // Add a finalizer to interrupt the fiber and close the executor
                this._currentChannel = this._currentChannel.channel as core.Primitive

                if (this._input !== undefined) {
                  const inputExecutor = this._input
                  this._input = undefined

                  const drainer = (): Effect.Effect<Env, never, unknown> =>
                    Effect.flatMap(bridgeInput.awaitRead(), () =>
                      Effect.suspendSucceed(() => {
                        const state = inputExecutor.run() as ChannelState.Primitive
                        switch (state._tag) {
                          case ChannelStateOpCodes.OP_DONE: {
                            return Exit.match(
                              inputExecutor.getDone(),
                              (cause) => bridgeInput.error(cause),
                              (value) => bridgeInput.done(value)
                            )
                          }
                          case ChannelStateOpCodes.OP_EMIT: {
                            return Effect.flatMap(
                              bridgeInput.emit(inputExecutor.getEmit()),
                              () => drainer()
                            )
                          }
                          case ChannelStateOpCodes.OP_FROM_EFFECT: {
                            return Effect.matchCauseEffect(
                              state.effect,
                              (cause) => bridgeInput.error(cause),
                              () => drainer()
                            )
                          }
                          case ChannelStateOpCodes.OP_READ: {
                            return readUpstream(
                              state,
                              () => drainer(),
                              (cause) => bridgeInput.error(cause)
                            )
                          }
                        }
                      })) as Effect.Effect<Env, never, unknown>

                  result = ChannelState.FromEffect(
                    Effect.flatMap(
                      Effect.forkDaemon(drainer()),
                      (fiber) =>
                        Effect.sync(() =>
                          this.addFinalizer((exit) =>
                            Effect.flatMap(Fiber.interrupt(fiber), () =>
                              Effect.suspendSucceed(() => {
                                const effect = this.restorePipe(exit, inputExecutor)
                                return effect !== undefined ? effect : Effect.unit()
                              }))
                          )
                        )
                    )
                  )
                }

                break
              }

              case ChannelOpCodes.OP_CONCAT_ALL: {
                const executor: ErasedExecutor<Env> = new ChannelExecutor(
                  this._currentChannel.value() as Channel.Channel<Env, unknown, unknown, unknown, never, never, never>,
                  this._providedEnv,
                  (effect) =>
                    Effect.sync(() => {
                      const prevLastClose = this._closeLastSubstream === undefined
                        ? Effect.unit()
                        : this._closeLastSubstream
                      this._closeLastSubstream = pipe(prevLastClose, Effect.zipRight(effect))
                    })
                )
                executor._input = this._input

                const channel = this._currentChannel
                this._activeSubexecutor = new Subexecutor.PullFromUpstream(
                  executor,
                  (value) => channel.k(value),
                  undefined,
                  [],
                  (x, y) => channel.combineInners(x, y),
                  (x, y) => channel.combineAll(x, y),
                  (request) => channel.onPull(request),
                  (value) => channel.onEmit(value)
                )

                this._closeLastSubstream = undefined
                this._currentChannel = undefined

                break
              }

              case ChannelOpCodes.OP_EMIT: {
                this._emitted = this._currentChannel.out
                this._currentChannel = (this._activeSubexecutor !== undefined ?
                  undefined :
                  core.unit()) as core.Primitive | undefined
                result = ChannelState.Emit()
                break
              }

              case ChannelOpCodes.OP_ENSURING: {
                this.runEnsuring(this._currentChannel)
                break
              }

              case ChannelOpCodes.OP_FAIL: {
                result = this.doneHalt(this._currentChannel.error())
                break
              }

              case ChannelOpCodes.OP_FOLD: {
                this._doneStack.push(this._currentChannel.k as ErasedContinuation<Env>)
                this._currentChannel = this._currentChannel.channel as core.Primitive
                break
              }

              case ChannelOpCodes.OP_FROM_EFFECT: {
                const effect = this._providedEnv === undefined ?
                  this._currentChannel.effect() :
                  pipe(
                    this._currentChannel.effect(),
                    Effect.provideContext(this._providedEnv)
                  )

                result = ChannelState.FromEffect(
                  pipe(
                    effect,
                    Effect.matchCauseEffect(
                      (cause) => {
                        const state = this.doneHalt(cause)
                        return state !== undefined && ChannelState.isFromEffect(state) ?
                          state.effect :
                          Effect.unit()
                      },
                      (value) => {
                        const state = this.doneSucceed(value)
                        return state !== undefined && ChannelState.isFromEffect(state) ?
                          state.effect :
                          Effect.unit()
                      }
                    )
                  )
                ) as ChannelState.ChannelState<Env, unknown> | undefined

                break
              }

              case ChannelOpCodes.OP_PIPE_TO: {
                const previousInput = this._input

                const leftExec: ErasedExecutor<Env> = new ChannelExecutor(
                  this._currentChannel.left() as Channel.Channel<Env, unknown, unknown, unknown, never, never, never>,
                  this._providedEnv,
                  (effect) => this._executeCloseLastSubstream(effect)
                )
                leftExec._input = previousInput
                this._input = leftExec

                this.addFinalizer((exit) => {
                  const effect = this.restorePipe(exit, previousInput)
                  return effect !== undefined ? effect : Effect.unit()
                })

                this._currentChannel = this._currentChannel.right() as core.Primitive

                break
              }

              case ChannelOpCodes.OP_PROVIDE: {
                const previousEnv = this._providedEnv
                this._providedEnv = this._currentChannel.context()
                this._currentChannel = this._currentChannel.inner as core.Primitive
                this.addFinalizer(() =>
                  Effect.sync(() => {
                    this._providedEnv = previousEnv
                  })
                )
                break
              }

              case ChannelOpCodes.OP_READ: {
                const read = this._currentChannel
                result = ChannelState.Read(
                  this._input!,
                  identity,
                  (emitted) => {
                    this._currentChannel = read.more(emitted) as core.Primitive
                    return undefined
                  },
                  (exit) => {
                    const onExit = (exit: Exit.Exit<unknown, unknown>): core.Primitive => {
                      return read.done.onExit(exit) as core.Primitive
                    }
                    this._currentChannel = onExit(exit)
                    return undefined
                  }
                )
                break
              }

              case ChannelOpCodes.OP_SUCCEED: {
                result = this.doneSucceed(this._currentChannel.evaluate())
                break
              }

              case ChannelOpCodes.OP_SUCCEED_NOW: {
                result = this.doneSucceed(this._currentChannel.terminal)
                break
              }

              case ChannelOpCodes.OP_SUSPEND: {
                this._currentChannel = this._currentChannel.channel() as core.Primitive
                break
              }

              case ChannelOpCodes.OP_TRACED: {
                this._traceStack.push(this._currentChannel.trace)
                this.addFinalizer(() =>
                  Effect.sync(() => {
                    this._traceStack.pop()
                  })
                )
                this._currentChannel = this._currentChannel.channel as core.Primitive
                break
              }

              default: {
                // @ts-expect-error
                this._currentChannel._tag
              }
            }
          }
        } catch (error) {
          this._currentChannel = core.failCause(Cause.die(error)) as core.Primitive
        }
      }
    }
    return result
  }

  stackToLines(): Chunk.Chunk<Debug.SourceLocation> {
    if (this._traceStack.length === 0) {
      return Chunk.empty()
    }
    const lines: Array<Debug.SourceLocation> = []
    let current = this._traceStack.length - 1
    while (current >= 0 && lines.length < Debug.runtimeDebug.traceStackLimit) {
      const value = this._traceStack[current]!
      lines.push(value)
      current = current - 1
    }
    return Chunk.unsafeFromArray(lines)
  }

  getDone(): Exit.Exit<OutErr, OutDone> {
    return this._done as Exit.Exit<OutErr, OutDone>
  }

  getEmit(): OutElem {
    return this._emitted as OutElem
  }

  cancelWith(exit: Exit.Exit<OutErr, OutDone>): void {
    this._cancelled = exit
  }

  clearInProgressFinalizer(): void {
    this._inProgressFinalizer = undefined
  }

  storeInProgressFinalizer(finalizer: Effect.Effect<Env, never, unknown> | undefined): void {
    this._inProgressFinalizer = finalizer
  }

  popAllFinalizers(exit: Exit.Exit<unknown, unknown>): Effect.Effect<Env, never, unknown> {
    return Debug.untraced(() => {
      const finalizers: Array<ErasedFinalizer<Env>> = []
      let next = this._doneStack.pop() as Continuation.Primitive | undefined
      while (next) {
        if (next._tag === "ContinuationFinalizer") {
          finalizers.push(next.finalizer as ErasedFinalizer<Env>)
        }
        next = this._doneStack.pop() as Continuation.Primitive | undefined
      }
      const effect = (finalizers.length === 0 ? Effect.unit() : runFinalizers(finalizers, exit)) as Effect.Effect<
        Env,
        never,
        unknown
      >
      this.storeInProgressFinalizer(effect)
      return effect
    })
  }

  popNextFinalizers(): Array<Continuation.ContinuationFinalizer<Env, unknown, unknown>> {
    const builder: Array<Continuation.ContinuationFinalizer<Env, unknown, unknown>> = []
    while (this._doneStack.length !== 0) {
      const cont = this._doneStack[this._doneStack.length - 1] as Continuation.Primitive
      if (cont._tag === ContinuationOpCodes.OP_CONTINUATION_K) {
        return builder
      }
      builder.push(cont as Continuation.ContinuationFinalizer<Env, unknown, unknown>)
      this._doneStack.pop()
    }
    return builder
  }

  restorePipe(
    exit: Exit.Exit<unknown, unknown>,
    prev: ErasedExecutor<Env> | undefined
  ): Effect.Effect<Env, never, unknown> | undefined {
    return Debug.untraced(() => {
      const currInput = this._input
      this._input = prev
      if (currInput !== undefined) {
        const effect = currInput.close(exit)
        return effect
      }
      return Effect.unit()
    })
  }

  close(exit: Exit.Exit<unknown, unknown>): Effect.Effect<Env, never, unknown> | undefined {
    return Debug.untraced(() => {
      let runInProgressFinalizers: Effect.Effect<Env, never, unknown> | undefined = undefined
      const finalizer = this._inProgressFinalizer
      if (finalizer !== undefined) {
        runInProgressFinalizers = pipe(
          finalizer,
          Effect.ensuring(Effect.sync(() => this.clearInProgressFinalizer()))
        )
      }

      let closeSelf: Effect.Effect<Env, never, unknown> | undefined = undefined
      const selfFinalizers = this.popAllFinalizers(exit)
      if (selfFinalizers !== undefined) {
        closeSelf = pipe(
          selfFinalizers,
          Effect.ensuring(Effect.sync(() => this.clearInProgressFinalizer()))
        )
      }

      const closeSubexecutors = this._activeSubexecutor === undefined ?
        undefined :
        this._activeSubexecutor.close(exit)

      if (
        closeSubexecutors === undefined &&
        runInProgressFinalizers === undefined &&
        closeSelf === undefined
      ) {
        return undefined
      }

      return pipe(
        Effect.exit(ifNotNull(closeSubexecutors)),
        Effect.zip(Effect.exit(ifNotNull(runInProgressFinalizers))),
        Effect.zip(Effect.exit(ifNotNull(closeSelf))),
        Effect.map(([[exit1, exit2], exit3]) => pipe(exit1, Exit.zipRight(exit2), Exit.zipRight(exit3))),
        Effect.uninterruptible,
        Effect.flatMap(Effect.done)
      )
    })
  }

  doneSucceed(value: unknown): ChannelState.ChannelState<Env, unknown> | undefined {
    if (this._doneStack.length === 0) {
      this._done = Exit.succeed(value)
      this._currentChannel = undefined
      return ChannelState.Done()
    }

    const head = this._doneStack[this._doneStack.length - 1] as Continuation.Primitive
    if (head._tag === ContinuationOpCodes.OP_CONTINUATION_K) {
      this._doneStack.pop()
      this._currentChannel = head.onSuccess(value) as core.Primitive
      return undefined
    }

    const finalizers = this.popNextFinalizers()
    if (this._doneStack.length === 0) {
      this._doneStack = finalizers.reverse()
      this._done = Exit.succeed(value)
      this._currentChannel = undefined
      return ChannelState.Done()
    }

    const finalizerEffect = runFinalizers(finalizers.map((f) => f.finalizer), Exit.succeed(value))!
    this.storeInProgressFinalizer(finalizerEffect)

    const effect = pipe(
      finalizerEffect,
      Effect.ensuring(Effect.sync(() => this.clearInProgressFinalizer())),
      Effect.uninterruptible,
      Effect.flatMap(() => Effect.sync(() => this.doneSucceed(value)))
    )

    return ChannelState.FromEffect(effect)
  }

  annotate<E>(_cause: Cause.Cause<E>) {
    let cause = _cause
    if (Cause.isAnnotatedType(cause) && Cause.isStackAnnotation(cause.annotation)) {
      const stack = cause.annotation.stack
      const currentStack = this.stackToLines()
      cause = Cause.annotated(
        cause.cause,
        new Cause.StackAnnotation(
          pipe(
            stack.length === 0 ?
              currentStack :
              currentStack.length === 0 ?
              stack :
              Chunk.unsafeLast(stack) === Chunk.unsafeLast(currentStack) ?
              stack :
              pipe(
                stack,
                Chunk.concat(currentStack)
              ),
            Chunk.dedupeAdjacent,
            Chunk.take(Debug.runtimeDebug.traceStackLimit)
          ),
          cause.annotation.seq
        )
      )
    } else {
      cause = Cause.annotated(
        cause,
        new Cause.StackAnnotation(this.stackToLines(), MRef.getAndIncrement(Cause.globalErrorSeq))
      )
    }
    return cause
  }

  doneHalt(cause: Cause.Cause<unknown>): ChannelState.ChannelState<Env, unknown> | undefined {
    if (this._doneStack.length === 0) {
      this._done = Exit.failCause(cause)
      this._currentChannel = undefined
      return ChannelState.Done()
    }

    const head = this._doneStack[this._doneStack.length - 1] as Continuation.Primitive
    if (head._tag === ContinuationOpCodes.OP_CONTINUATION_K) {
      this._doneStack.pop()
      this._currentChannel = head.onHalt(cause) as core.Primitive
      return undefined
    }

    const finalizers = this.popNextFinalizers()
    if (this._doneStack.length === 0) {
      this._doneStack = finalizers.reverse()
      this._done = Exit.failCause(cause)
      this._currentChannel = undefined
      return ChannelState.Done()
    }

    const finalizerEffect = runFinalizers(finalizers.map((f) => f.finalizer), Exit.failCause(cause))!
    this.storeInProgressFinalizer(finalizerEffect)

    const effect = pipe(
      finalizerEffect,
      Effect.ensuring(Effect.sync(() => this.clearInProgressFinalizer())),
      Effect.uninterruptible,
      Effect.flatMap(() => Effect.sync(() => this.doneHalt(cause)))
    )

    return ChannelState.FromEffect(effect)
  }

  processCancellation(): ChannelState.ChannelState<Env, unknown> {
    this._currentChannel = undefined
    this._done = this._cancelled
    this._cancelled = undefined
    return ChannelState.Done()
  }

  runBracketOut(bracketOut: core.BracketOut): ChannelState.ChannelState<Env, unknown> {
    const effect = pipe(
      this.provide(bracketOut.acquire() as Effect.Effect<Env, OutErr, OutDone>),
      Effect.matchCauseEffect(
        (cause) =>
          Effect.sync(() => {
            this._currentChannel = core.failCause(cause) as core.Primitive
          }),
        (out) =>
          Effect.sync(() => {
            this.addFinalizer((exit) =>
              this.provide(bracketOut.finalizer(out, exit)) as Effect.Effect<Env, never, unknown>
            )
            this._currentChannel = core.write(out) as core.Primitive
          })
      ),
      Effect.uninterruptible
    )
    return ChannelState.FromEffect(effect) as ChannelState.ChannelState<Env, unknown>
  }

  provide(effect: Effect.Effect<unknown, unknown, unknown>): Effect.Effect<unknown, unknown, unknown> {
    if (this._providedEnv === undefined) {
      return effect
    }
    return pipe(effect, Effect.provideContext(this._providedEnv))
  }

  runEnsuring(ensuring: core.Ensuring): void {
    this.addFinalizer(ensuring.finalizer as ErasedFinalizer<Env>)
    this._currentChannel = ensuring.channel as core.Primitive
  }

  addFinalizer(f: ErasedFinalizer<Env>): void {
    this._doneStack.push(new Continuation.ContinuationFinalizerImpl(f))
  }

  runSubexecutor(): ChannelState.ChannelState<Env, unknown> | undefined {
    const subexecutor = this._activeSubexecutor as Subexecutor.Primitive<Env>
    switch (subexecutor._tag) {
      case Subexecutor.OP_PULL_FROM_CHILD: {
        return this.pullFromChild(
          subexecutor.childExecutor,
          subexecutor.parentSubexecutor,
          subexecutor.onEmit,
          subexecutor
        )
      }
      case Subexecutor.OP_PULL_FROM_UPSTREAM: {
        return this.pullFromUpstream(subexecutor)
      }
      case Subexecutor.OP_DRAIN_CHILD_EXECUTORS: {
        return this.drainChildExecutors(subexecutor)
      }
      case Subexecutor.OP_EMIT: {
        this._emitted = subexecutor.value
        this._activeSubexecutor = subexecutor.next
        return ChannelState.Emit()
      }
    }
  }

  replaceSubexecutor(nextSubExec: Subexecutor.Subexecutor<Env>): void {
    this._currentChannel = undefined
    this._activeSubexecutor = nextSubExec
  }

  finishWithExit(exit: Exit.Exit<unknown, unknown>): Effect.Effect<Env, unknown, unknown> {
    return Debug.untraced(() => {
      const state = pipe(
        exit,
        Exit.match(
          (cause) => this.doneHalt(cause),
          (value) => this.doneSucceed(value)
        )
      )
      this._activeSubexecutor = undefined
      return state === undefined ?
        Effect.unit() :
        ChannelState.effect(state)
    })
  }

  finishSubexecutorWithCloseEffect(
    subexecutorDone: Exit.Exit<unknown, unknown>,
    ...closeFuncs: Array<(exit: Exit.Exit<unknown, unknown>) => Effect.Effect<Env, never, unknown> | undefined>
  ): ChannelState.ChannelState<Env, unknown> | undefined {
    this.addFinalizer(() =>
      pipe(
        closeFuncs,
        Effect.forEachDiscard((closeFunc) =>
          pipe(
            Effect.sync(() => closeFunc(subexecutorDone)),
            Effect.flatMap((closeEffect) => closeEffect !== undefined ? closeEffect : Effect.unit())
          )
        )
      )
    )
    const state = pipe(
      subexecutorDone,
      Exit.match(
        (cause) => this.doneHalt(cause),
        (value) => this.doneSucceed(value)
      )
    )
    this._activeSubexecutor = undefined
    return state
  }

  applyUpstreamPullStrategy(
    upstreamFinished: boolean,
    queue: ReadonlyArray<Subexecutor.PullFromChild<Env> | undefined>,
    strategy: UpstreamPullStrategy.UpstreamPullStrategy<unknown>
  ): readonly [Option.Option<unknown>, ReadonlyArray<Subexecutor.PullFromChild<Env> | undefined>] {
    switch (strategy._tag) {
      case UpstreamPullStrategyOpCodes.OP_PULL_AFTER_NEXT: {
        const shouldPrepend = !upstreamFinished || queue.some((subexecutor) => subexecutor !== undefined)
        return [strategy.emitSeparator, shouldPrepend ? [undefined, ...queue] : queue]
      }
      case UpstreamPullStrategyOpCodes.OP_PULL_AFTER_ALL_ENQUEUED: {
        const shouldEnqueue = !upstreamFinished || queue.some((subexecutor) => subexecutor !== undefined)
        return [strategy.emitSeparator, shouldEnqueue ? [...queue, undefined] : queue]
      }
    }
  }

  pullFromChild(
    childExecutor: ErasedExecutor<Env>,
    parentSubexecutor: Subexecutor.Subexecutor<Env>,
    onEmitted: (emitted: unknown) => ChildExecutorDecision.ChildExecutorDecision,
    subexecutor: Subexecutor.PullFromChild<Env>
  ): ChannelState.ChannelState<Env, unknown> | undefined {
    return ChannelState.Read(
      childExecutor,
      identity,
      (emitted) => {
        const childExecutorDecision = onEmitted(emitted)
        switch (childExecutorDecision._tag) {
          case ChildExecutorDecisionOpCodes.OP_CONTINUE: {
            break
          }
          case ChildExecutorDecisionOpCodes.OP_CLOSE: {
            this.finishWithDoneValue(childExecutor, parentSubexecutor, childExecutorDecision.value)
            break
          }
          case ChildExecutorDecisionOpCodes.OP_YIELD: {
            const modifiedParent = parentSubexecutor.enqueuePullFromChild(subexecutor)
            this.replaceSubexecutor(modifiedParent)
            break
          }
        }
        this._activeSubexecutor = new Subexecutor.Emit(emitted, this._activeSubexecutor!)
        return undefined
      },
      Exit.match(
        (cause) => {
          const state = this.handleSubexecutorFailure(childExecutor, parentSubexecutor, cause)
          return state === undefined ?
            undefined :
            ChannelState.effectOrUndefinedIgnored(state) as Effect.Effect<Env, never, void>
        },
        (doneValue) => {
          this.finishWithDoneValue(childExecutor, parentSubexecutor, doneValue)
          return undefined
        }
      )
    )
  }

  finishWithDoneValue(
    childExecutor: ErasedExecutor<Env>,
    parentSubexecutor: Subexecutor.Subexecutor<Env>,
    doneValue: unknown
  ): void {
    const subexecutor = parentSubexecutor as Subexecutor.Primitive<Env>
    switch (subexecutor._tag) {
      case Subexecutor.OP_PULL_FROM_UPSTREAM: {
        const modifiedParent = new Subexecutor.PullFromUpstream(
          subexecutor.upstreamExecutor,
          subexecutor.createChild,
          subexecutor.lastDone !== undefined
            ? subexecutor.combineChildResults(
              subexecutor.lastDone,
              doneValue
            )
            : doneValue,
          subexecutor.activeChildExecutors,
          subexecutor.combineChildResults,
          subexecutor.combineWithChildResult,
          subexecutor.onPull,
          subexecutor.onEmit
        )
        this._closeLastSubstream = childExecutor.close(Exit.succeed(doneValue))
        this.replaceSubexecutor(modifiedParent)
        break
      }
      case Subexecutor.OP_DRAIN_CHILD_EXECUTORS: {
        const modifiedParent = new Subexecutor.DrainChildExecutors(
          subexecutor.upstreamExecutor,
          subexecutor.lastDone !== undefined
            ? subexecutor.combineChildResults(
              subexecutor.lastDone,
              doneValue
            )
            : doneValue,
          subexecutor.activeChildExecutors,
          subexecutor.upstreamDone,
          subexecutor.combineChildResults,
          subexecutor.combineWithChildResult,
          subexecutor.onPull
        )
        this._closeLastSubstream = childExecutor.close(Exit.succeed(doneValue))
        this.replaceSubexecutor(modifiedParent)
        break
      }
      default: {
        break
      }
    }
  }

  handleSubexecutorFailure(
    childExecutor: ErasedExecutor<Env>,
    parentSubexecutor: Subexecutor.Subexecutor<Env>,
    cause: Cause.Cause<unknown>
  ): ChannelState.ChannelState<Env, unknown> | undefined {
    return this.finishSubexecutorWithCloseEffect(
      Exit.failCause(cause),
      (exit) => parentSubexecutor.close(exit),
      (exit) => childExecutor.close(exit)
    )
  }

  pullFromUpstream(
    subexecutor: Subexecutor.PullFromUpstream<Env>
  ): ChannelState.ChannelState<Env, unknown> | undefined {
    if (subexecutor.activeChildExecutors.length === 0) {
      return this.performPullFromUpstream(subexecutor)
    }

    const activeChild = subexecutor.activeChildExecutors[0]

    const parentSubexecutor = new Subexecutor.PullFromUpstream(
      subexecutor.upstreamExecutor,
      subexecutor.createChild,
      subexecutor.lastDone,
      subexecutor.activeChildExecutors.slice(1),
      subexecutor.combineChildResults,
      subexecutor.combineWithChildResult,
      subexecutor.onPull,
      subexecutor.onEmit
    )

    if (activeChild === undefined) {
      return this.performPullFromUpstream(parentSubexecutor)
    }

    this.replaceSubexecutor(
      new Subexecutor.PullFromChild(
        activeChild.childExecutor,
        parentSubexecutor,
        activeChild.onEmit
      )
    )

    return undefined
  }

  performPullFromUpstream(
    subexecutor: Subexecutor.PullFromUpstream<Env>
  ): ChannelState.ChannelState<Env, unknown> | undefined {
    return ChannelState.Read(
      subexecutor.upstreamExecutor,
      (effect) => {
        const closeLastSubstream = this._closeLastSubstream === undefined ? Effect.unit() : this._closeLastSubstream
        this._closeLastSubstream = undefined
        return pipe(
          this._executeCloseLastSubstream(closeLastSubstream),
          Effect.zipRight(effect)
        )
      },
      (emitted) => {
        if (this._closeLastSubstream !== undefined) {
          const closeLastSubstream = this._closeLastSubstream
          this._closeLastSubstream = undefined
          return pipe(
            this._executeCloseLastSubstream(closeLastSubstream),
            Effect.map(() => {
              const childExecutor: ErasedExecutor<Env> = new ChannelExecutor(
                subexecutor.createChild(emitted),
                this._providedEnv,
                this._executeCloseLastSubstream
              )

              childExecutor._input = this._input

              const [emitSeparator, updatedChildExecutors] = this.applyUpstreamPullStrategy(
                false,
                subexecutor.activeChildExecutors,
                subexecutor.onPull(upstreamPullRequest.Pulled(emitted))
              )

              this._activeSubexecutor = new Subexecutor.PullFromChild(
                childExecutor,
                new Subexecutor.PullFromUpstream(
                  subexecutor.upstreamExecutor,
                  subexecutor.createChild,
                  subexecutor.lastDone,
                  updatedChildExecutors,
                  subexecutor.combineChildResults,
                  subexecutor.combineWithChildResult,
                  subexecutor.onPull,
                  subexecutor.onEmit
                ),
                subexecutor.onEmit
              )

              if (Option.isSome(emitSeparator)) {
                this._activeSubexecutor = new Subexecutor.Emit(emitSeparator.value, this._activeSubexecutor)
              }

              return undefined
            })
          )
        }

        const childExecutor: ErasedExecutor<Env> = new ChannelExecutor(
          subexecutor.createChild(emitted),
          this._providedEnv,
          this._executeCloseLastSubstream
        )

        childExecutor._input = this._input

        const [emitSeparator, updatedChildExecutors] = this.applyUpstreamPullStrategy(
          false,
          subexecutor.activeChildExecutors,
          subexecutor.onPull(upstreamPullRequest.Pulled(emitted))
        )

        this._activeSubexecutor = new Subexecutor.PullFromChild(
          childExecutor,
          new Subexecutor.PullFromUpstream(
            subexecutor.upstreamExecutor,
            subexecutor.createChild,
            subexecutor.lastDone,
            updatedChildExecutors,
            subexecutor.combineChildResults,
            subexecutor.combineWithChildResult,
            subexecutor.onPull,
            subexecutor.onEmit
          ),
          subexecutor.onEmit
        )

        if (Option.isSome(emitSeparator)) {
          this._activeSubexecutor = new Subexecutor.Emit(emitSeparator.value, this._activeSubexecutor)
        }

        return undefined
      },
      (exit) => {
        if (subexecutor.activeChildExecutors.some((subexecutor) => subexecutor !== undefined)) {
          const drain = new Subexecutor.DrainChildExecutors(
            subexecutor.upstreamExecutor,
            subexecutor.lastDone,
            [undefined, ...subexecutor.activeChildExecutors],
            subexecutor.upstreamExecutor.getDone(),
            subexecutor.combineChildResults,
            subexecutor.combineWithChildResult,
            subexecutor.onPull
          )

          if (this._closeLastSubstream !== undefined) {
            const closeLastSubstream = this._closeLastSubstream
            this._closeLastSubstream = undefined
            return pipe(
              this._executeCloseLastSubstream(closeLastSubstream),
              Effect.map(() => this.replaceSubexecutor(drain))
            )
          }

          this.replaceSubexecutor(drain)

          return undefined
        }

        const closeLastSubstream = this._closeLastSubstream
        const state = this.finishSubexecutorWithCloseEffect(
          pipe(exit, Exit.map((a) => subexecutor.combineWithChildResult(subexecutor.lastDone, a))),
          () => closeLastSubstream,
          (exit) => subexecutor.upstreamExecutor.close(exit)
        )
        return state === undefined ?
          undefined :
          // NOTE: assuming finalizers cannot fail
          ChannelState.effectOrUndefinedIgnored(state as ChannelState.ChannelState<Env, never>)
      }
    )
  }

  drainChildExecutors(
    subexecutor: Subexecutor.DrainChildExecutors<Env>
  ): ChannelState.ChannelState<Env, unknown> | undefined {
    if (subexecutor.activeChildExecutors.length === 0) {
      const lastClose = this._closeLastSubstream
      if (lastClose !== undefined) {
        this.addFinalizer(() => Effect.succeed(lastClose))
      }
      return this.finishSubexecutorWithCloseEffect(
        subexecutor.upstreamDone,
        () => lastClose,
        (exit) => subexecutor.upstreamExecutor.close(exit)
      )
    }

    const activeChild = subexecutor.activeChildExecutors[0]
    const rest = subexecutor.activeChildExecutors.slice(1)

    if (activeChild === undefined) {
      const [emitSeparator, remainingExecutors] = this.applyUpstreamPullStrategy(
        true,
        rest,
        subexecutor.onPull(
          upstreamPullRequest.NoUpstream(rest.reduce((n, curr) => curr !== undefined ? n + 1 : n, 0))
        )
      )

      this.replaceSubexecutor(
        new Subexecutor.DrainChildExecutors(
          subexecutor.upstreamExecutor,
          subexecutor.lastDone,
          remainingExecutors,
          subexecutor.upstreamDone,
          subexecutor.combineChildResults,
          subexecutor.combineWithChildResult,
          subexecutor.onPull
        )
      )

      if (Option.isSome(emitSeparator)) {
        this._emitted = emitSeparator.value
        return ChannelState.Emit()
      }

      return undefined
    }

    const parentSubexecutor = new Subexecutor.DrainChildExecutors(
      subexecutor.upstreamExecutor,
      subexecutor.lastDone,
      rest,
      subexecutor.upstreamDone,
      subexecutor.combineChildResults,
      subexecutor.combineWithChildResult,
      subexecutor.onPull
    )

    this.replaceSubexecutor(
      new Subexecutor.PullFromChild(
        activeChild.childExecutor,
        parentSubexecutor,
        activeChild.onEmit
      )
    )

    return undefined
  }
}

const ifNotNull = Debug.untracedMethod(() =>
  <Env>(effect: Effect.Effect<Env, never, unknown> | undefined): Effect.Effect<Env, never, unknown> =>
    effect !== undefined ?
      effect :
      Effect.unit()
)

const runFinalizers = Debug.untracedMethod(() =>
  <Env>(
    finalizers: Array<ErasedFinalizer<Env>>,
    exit: Exit.Exit<unknown, unknown>
  ): Effect.Effect<Env, never, unknown> => {
    return pipe(
      Effect.forEach(finalizers, (fin) => Effect.exit(fin(exit))),
      Effect.map((exits) => pipe(Exit.collectAll(exits), Option.getOrElse(() => Exit.unit()))),
      Effect.flatMap((exit) => Effect.done(exit as Exit.Exit<never, unknown>))
    )
  }
)

/**
 * @internal
 */
export const readUpstream = Debug.methodWithTrace((trace) =>
  <R, E, E2, A>(
    r: ChannelState.Read,
    onSuccess: () => Effect.Effect<R, E2, A>,
    onFailure: (cause: Cause.Cause<E>) => Effect.Effect<R, E2, A>
  ): Effect.Effect<R, E2, A> => {
    const readStack = [r as ChannelState.Read]
    const read = (): Effect.Effect<R, E2, A> => {
      const current = readStack.pop()
      if (current === undefined || current.upstream === undefined) {
        return Effect.dieMessage("Unexpected end of input for channel execution")
      }
      const state = current.upstream.run() as ChannelState.Primitive
      switch (state._tag) {
        case ChannelStateOpCodes.OP_EMIT: {
          const emitEffect = current.onEmit(current.upstream.getEmit())
          if (readStack.length === 0) {
            if (emitEffect === undefined) {
              return Effect.suspendSucceed(onSuccess)
            }
            return pipe(
              emitEffect as Effect.Effect<never, never, void>,
              Effect.matchCauseEffect(onFailure, onSuccess)
            ).traced(trace)
          }
          if (emitEffect === undefined) {
            return Effect.suspendSucceed(() => read()).traced(trace)
          }
          return pipe(
            emitEffect as Effect.Effect<never, never, void>,
            Effect.matchCauseEffect(onFailure, () => read())
          ).traced(trace)
        }

        case ChannelStateOpCodes.OP_DONE: {
          const doneEffect = current.onDone(current.upstream.getDone())
          if (readStack.length === 0) {
            if (doneEffect === undefined) {
              return Effect.suspendSucceed(onSuccess).traced(trace)
            }
            return pipe(
              doneEffect as Effect.Effect<never, never, void>,
              Effect.matchCauseEffect(onFailure, () => onSuccess())
            ).traced(trace)
          }
          if (doneEffect === undefined) {
            return Effect.suspendSucceed(() => read()).traced(trace)
          }
          return pipe(
            doneEffect as Effect.Effect<never, never, void>,
            Effect.matchCauseEffect(onFailure, () => read())
          ).traced(trace)
        }

        case ChannelStateOpCodes.OP_FROM_EFFECT: {
          readStack.push(current)
          return pipe(
            current.onEffect(state.effect as Effect.Effect<never, never, void>) as Effect.Effect<never, never, void>,
            Effect.catchAllCause((cause) =>
              Effect.suspendSucceed(() => {
                const doneEffect = current.onDone(Exit.failCause(cause)) as Effect.Effect<never, never, void>
                return doneEffect === undefined ? Effect.unit() : doneEffect
              })
            ),
            Effect.matchCauseEffect(onFailure, () => read())
          ).traced(trace)
        }

        case ChannelStateOpCodes.OP_READ: {
          readStack.push(current)
          readStack.push(state)
          return Effect.suspendSucceed(() => read()).traced(trace)
        }
      }
    }
    return read()
  }
)

/** @internal */
export const run = Debug.methodWithTrace((trace) =>
  <Env, InErr, InDone, OutErr, OutDone>(
    self: Channel.Channel<Env, InErr, unknown, InDone, OutErr, never, OutDone>
  ): Effect.Effect<Env, OutErr, OutDone> => pipe(runScoped(self), Effect.scoped).traced(trace)
)

/** @internal */
export const runScoped = <Env, InErr, InDone, OutErr, OutDone>(
  self: Channel.Channel<Env, InErr, unknown, InDone, OutErr, never, OutDone>
): Effect.Effect<Env | Scope.Scope, OutErr, OutDone> => {
  const run = (deferred: Deferred.Deferred<OutErr, OutDone>, scope: Scope.Scope) =>
    Effect.acquireUseRelease(
      Effect.sync(() => new ChannelExecutor(self, void 0, identity)),
      (exec) =>
        Effect.suspendSucceed(() =>
          pipe(
            runScopedInterpret(exec.run() as ChannelState.ChannelState<Env, OutErr>, exec),
            Effect.intoDeferred(deferred),
            Effect.zipRight(Deferred.await(deferred)),
            Effect.zipLeft(Effect.never())
          )
        ),
      (exec, exit) => {
        const finalize = exec.close(exit)
        if (finalize === undefined) {
          return Effect.unit()
        }
        return Effect.tapErrorCause(
          finalize,
          (cause) => Scope.addFinalizer(scope, Effect.failCause(cause))
        )
      }
    )
  return Effect.flatMap(Effect.scope(), (parent) =>
    Effect.flatMap(
      Scope.fork(parent, ExecutionStrategy.sequential),
      (child) =>
        Effect.flatMap(Deferred.make<OutErr, OutDone>(), (deferred) =>
          Effect.flatMap(Effect.forkScoped(run(deferred, child)), (fiber) =>
            Effect.zipLeft(Deferred.await(deferred), Fiber.inheritAll(fiber))))
    ))
}

/** @internal */
const runScopedInterpret = <Env, InErr, InDone, OutErr, OutDone>(
  channelState: ChannelState.ChannelState<Env, OutErr>,
  exec: ChannelExecutor<Env, InErr, unknown, InDone, OutErr, never, OutDone>
): Effect.Effect<Env, OutErr, OutDone> => {
  const op = channelState as ChannelState.Primitive
  switch (op._tag) {
    case ChannelStateOpCodes.OP_FROM_EFFECT: {
      return pipe(
        op.effect as Effect.Effect<Env, OutErr, OutDone>,
        Effect.flatMap(() => runScopedInterpret(exec.run() as ChannelState.ChannelState<Env, OutErr>, exec))
      )
    }
    case ChannelStateOpCodes.OP_EMIT: {
      // Can't really happen because Out <:< Nothing. So just skip ahead.
      return runScopedInterpret<Env, InErr, InDone, OutErr, OutDone>(
        exec.run() as ChannelState.ChannelState<Env, OutErr>,
        exec
      )
    }
    case ChannelStateOpCodes.OP_DONE: {
      return Effect.done(exec.getDone())
    }
    case ChannelStateOpCodes.OP_READ: {
      return readUpstream(
        op,
        () => runScopedInterpret(exec.run() as ChannelState.ChannelState<Env, OutErr>, exec),
        Effect.failCause
      ) as Effect.Effect<Env, OutErr, OutDone>
    }
  }
}
