export const MAX_RETRIES = 3

export interface GuardState {
  readonly counts: Readonly<Record<string, number>>
}

export function freshGuardState(): GuardState {
  return { counts: {} }
}

export function guardIncrement(state: GuardState, sessionId: string): GuardState {
  return {
    counts: {
      ...state.counts,
      [sessionId]: (state.counts[sessionId] ?? 0) + 1,
    },
  }
}

export function guardReset(state: GuardState, sessionId: string): GuardState {
  const { [sessionId]: _removed, ...rest } = state.counts
  return { counts: rest }
}

export function guardCount(state: GuardState, sessionId: string): number {
  return state.counts[sessionId] ?? 0
}

export function guardExceeded(
  state: GuardState,
  sessionId: string,
  max: number = MAX_RETRIES,
): boolean {
  return guardCount(state, sessionId) >= max
}
