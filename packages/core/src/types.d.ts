export type JixuEvent = {
    type: 'TurnEnded';
    sessionId: string;
} | {
    type: 'RateLimited';
    resets_at?: number;
    raw?: string;
} | {
    type: 'ConnDead';
    raw?: string;
} | {
    type: 'Stalled';
} | {
    type: 'ApiError';
    reason: ApiErrorReason;
    resets_at?: number;
    raw?: string;
};
export type ApiErrorReason = 'overloaded' | 'rate_limit' | 'conn_reset' | 'auth_failed' | 'billing_failed' | 'context_too_long' | 'invalid_request';
export declare const FATAL_REASONS: Set<ApiErrorReason>;
export interface AdapterCapabilities {
    /** strong = StopFailure hook 可用；weak = 仅 log-tail 兜底 */
    errorDetect: 'strong' | 'weak';
    /** 是否能获取 resets_at 精确时间 */
    resetTime: boolean;
    /** 是否支持 PTY 交互式续接 */
    forceContinue: boolean;
}
export interface UsageInfo {
    fiveHour?: {
        used: number;
        resets_at: number;
    };
    sevenDay?: {
        used: number;
        resets_at: number;
    };
}
export interface IToolAdapter {
    readonly id: string;
    readonly capabilities: AdapterCapabilities;
    resume(mode: 'headless' | 'pty', sessionId: string): Promise<void>;
    usage(): Promise<UsageInfo>;
    kill(pid: number): Promise<void>;
}
export interface JobFile {
    event: JixuEvent;
    sessionId: string;
    pid?: number;
    timestamp: number;
}
export type Decision = {
    action: 'sleep';
    until: number;
    then: 'resume';
} | {
    action: 'kill_resume';
} | {
    action: 'backoff_resume';
    delayMs: number;
} | {
    action: 'stop';
    reason: StopReason;
} | {
    action: 'noop';
};
export type StopReason = 'fatal_error' | 'guard_exceeded' | 'turn_ended';
//# sourceMappingURL=types.d.ts.map