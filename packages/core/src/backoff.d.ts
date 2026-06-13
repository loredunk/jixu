export declare const BASE_MS = 5000;
export declare const CAP_MS: number;
/** retry-after header 的额外缓冲（与 engine 的 RETRY_AFTER_BUFFER_MS 含义不同，勿混淆） */
export declare const RETRY_AFTER_BUFFER_MS = 10000;
export interface BackoffOptions {
    attempt: number;
    retryAfterMs?: number;
}
/** 确定性退避（无 jitter），用于测试断言 */
export declare function calcDelay(opts: BackoffOptions): number;
/** 带 jitter 的退避（±30%），生产使用；random 可注入以便单测 */
export declare function calcDelayWithJitter(opts: BackoffOptions, random?: () => number): number;
//# sourceMappingURL=backoff.d.ts.map