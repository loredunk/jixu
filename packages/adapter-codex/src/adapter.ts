import type { IToolAdapter, AdapterCapabilities, UsageInfo } from '@jixu/core'

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`CodexAdapter.${method} 未实现（M3 里程碑）`)
    this.name = 'NotImplementedError'
  }
}

/**
 * Codex 适配器占位。
 * 实现 IToolAdapter 接口但全部方法 throw NotImplementedError，
 * 证明架构可在不修改 core 和 waiter 的前提下接入新工具。
 */
export class CodexAdapter implements IToolAdapter {
  readonly id = 'codex'

  readonly capabilities: AdapterCapabilities = {
    errorDetect: 'weak',
    resetTime: false,
    forceContinue: false,
  }

  resume(_mode: 'headless' | 'pty', _sessionId: string): Promise<void> {
    throw new NotImplementedError('resume')
  }

  usage(): Promise<UsageInfo> {
    throw new NotImplementedError('usage')
  }

  kill(_pid: number): Promise<void> {
    throw new NotImplementedError('kill')
  }
}
