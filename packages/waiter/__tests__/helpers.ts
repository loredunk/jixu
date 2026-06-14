import type { IToolAdapter, AdapterCapabilities, UsageInfo } from '@jixu/core'

export interface MockAdapter extends IToolAdapter {
  calls: {
    resume: Array<{ mode: 'headless' | 'pty'; sessionId: string }>
    kill: number[]
    usage: number
  }
}

/** 记录所有调用的假 adapter，供 executor / daemon 测试断言 */
export function makeMockAdapter(): MockAdapter {
  const calls: MockAdapter['calls'] = { resume: [], kill: [], usage: 0 }
  const capabilities: AdapterCapabilities = {
    errorDetect: 'strong',
    resetTime: true,
    forceContinue: false,
  }
  return {
    id: 'mock',
    capabilities,
    async resume(mode, sessionId) {
      calls.resume.push({ mode, sessionId })
    },
    async kill(pid) {
      calls.kill.push(pid)
    },
    async usage(): Promise<UsageInfo> {
      calls.usage++
      return {}
    },
    calls,
  }
}

/** 立即返回的 sleep，测试里消除真实等待 */
export const instantSleep = (): Promise<void> => Promise.resolve()
