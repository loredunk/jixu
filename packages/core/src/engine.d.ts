import { type JixuEvent, type Decision } from './types.js';
import { type GuardState } from './guard.js';
export declare const SLEEP_BUFFER_MS = 30000;
export interface EngineOptions {
    maxRetries?: number;
    sleepBufferMs?: number;
    /** 注入随机函数，用于单测消除 jitter */
    random?: () => number;
}
/**
 * 纯函数决策引擎：给定事件 + 当前 guard 状态 → 返回应执行的动作。
 * 无副作用，不依赖任何 Node.js API，完全可单测。
 */
export declare function decide(event: JixuEvent, sessionId: string, guardState: GuardState, opts?: EngineOptions): Decision;
//# sourceMappingURL=engine.d.ts.map