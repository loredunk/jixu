"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RETRY_AFTER_BUFFER_MS = exports.CAP_MS = exports.BASE_MS = void 0;
exports.calcDelay = calcDelay;
exports.calcDelayWithJitter = calcDelayWithJitter;
exports.BASE_MS = 5_000; // 首次退避 5s
exports.CAP_MS = 30 * 60_000; // 退避上限 30min
/** retry-after header 的额外缓冲（与 engine 的 RETRY_AFTER_BUFFER_MS 含义不同，勿混淆） */
exports.RETRY_AFTER_BUFFER_MS = 10_000;
/** 确定性退避（无 jitter），用于测试断言 */
function calcDelay(opts) {
    if (opts.retryAfterMs !== undefined) {
        return opts.retryAfterMs + exports.RETRY_AFTER_BUFFER_MS;
    }
    return Math.min(exports.BASE_MS * Math.pow(2, opts.attempt), exports.CAP_MS);
}
/** 带 jitter 的退避（±30%），生产使用；random 可注入以便单测 */
function calcDelayWithJitter(opts, random = Math.random) {
    if (opts.retryAfterMs !== undefined) {
        return opts.retryAfterMs + exports.RETRY_AFTER_BUFFER_MS;
    }
    const base = Math.min(exports.BASE_MS * Math.pow(2, opts.attempt), exports.CAP_MS);
    const jitter = base * 0.3 * random();
    return Math.round(base + jitter);
}
//# sourceMappingURL=backoff.js.map