export declare const MAX_RETRIES = 3;
export interface GuardState {
    readonly counts: Readonly<Record<string, number>>;
}
export declare function freshGuardState(): GuardState;
export declare function guardIncrement(state: GuardState, sessionId: string): GuardState;
export declare function guardReset(state: GuardState, sessionId: string): GuardState;
export declare function guardCount(state: GuardState, sessionId: string): number;
export declare function guardExceeded(state: GuardState, sessionId: string, max?: number): boolean;
//# sourceMappingURL=guard.d.ts.map