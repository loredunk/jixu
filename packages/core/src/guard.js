"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_RETRIES = void 0;
exports.freshGuardState = freshGuardState;
exports.guardIncrement = guardIncrement;
exports.guardReset = guardReset;
exports.guardCount = guardCount;
exports.guardExceeded = guardExceeded;
exports.MAX_RETRIES = 3;
function freshGuardState() {
    return { counts: {} };
}
function guardIncrement(state, sessionId) {
    return {
        counts: {
            ...state.counts,
            [sessionId]: (state.counts[sessionId] ?? 0) + 1,
        },
    };
}
function guardReset(state, sessionId) {
    const { [sessionId]: _removed, ...rest } = state.counts;
    return { counts: rest };
}
function guardCount(state, sessionId) {
    return state.counts[sessionId] ?? 0;
}
function guardExceeded(state, sessionId, max = exports.MAX_RETRIES) {
    return guardCount(state, sessionId) >= max;
}
//# sourceMappingURL=guard.js.map