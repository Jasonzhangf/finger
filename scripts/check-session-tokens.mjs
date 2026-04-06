import { SessionManager } from '../dist/orchestration/session-manager.js';

const sessionManager = new SessionManager();
const session = sessionManager.getSession('hb-session-finger-system-agent-global');

console.log('[Check] Session:', {
  id: session?.id,
  totalTokens: session?.totalTokens,
  latestCompactIndex: session?.latestCompactIndex,
  originalStartIndex: session?.originalStartIndex,
  originalEndIndex: session?.originalEndIndex,
});

console.log('[Check] Threshold: 222822 (85% of 262144)');
console.log('[Check] Needs compression:', (session?.totalTokens ?? 0) > 222822);

const session2 = sessionManager.getSession('session-7db9443c-053c-4250-862f-ad9c4f766c14');
console.log('\n[Check] Session 2:', {
  id: session2?.id,
  totalTokens: session2?.totalTokens,
  latestCompactIndex: session2?.latestCompactIndex,
  originalStartIndex: session2?.originalStartIndex,
  originalEndIndex: session2?.originalEndIndex,
});
