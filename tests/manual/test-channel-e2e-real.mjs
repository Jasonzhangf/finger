/**
 * Real Channel E2E Test - Inside-Out Methodology
 * 
 * Layer 1: Unit Test (路由逻辑)
 * Layer 2: Integration Test (MessageHub集成)
 * Layer 3: Real E2E Test (真实消息处理)
 */

import http from 'http';

// 1. Health check
console.log('[E2E] Step 1: Daemon health check');
const health = await new Promise((resolve, reject) => {
  const req = http.request({
    hostname: '127.0.0.1',
    port: 9999,
    path: '/health',
    method: 'GET',
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => resolve(JSON.parse(data)));
  });
  req.on('error', reject);
  req.end();
});
console.log('[E2E] Health:', health.status);

if (health.status !== 'healthy') {
  console.error('[E2E] Daemon not healthy, abort');
  process.exit(1);
}

// 2. 通过 HTTP API 发送测试消息（模拟真实 QQBot 消息进入系统）
console.log('\n[E2E] Step 2: Send test message to system');
const testPayload = {
  id: 'test-msg-' + Date.now(),
  channelId: 'qqbot',
  accountId: 'default',
  type: 'direct',
  senderId: 'test-user-001',
  content: '你好，这是测试消息',
  timestamp: Date.now(),
  metadata: {
    messageId: 'qq-test-msg-' + Date.now(),
  }
};

// 3. 通过 /api/v1/message 发送消息（这是真正的消息入口）
const result = await new Promise((resolve, reject) => {
  const payload = JSON.stringify({
    message: testPayload.content,
    targetAgentId: 'finger-system-agent',
    sessionId: 'test-session-' + Date.now(),
    channelContext: {
      channelId: 'qqbot',
      senderId: testPayload.senderId,
      messageId: testPayload.metadata.messageId,
    }
  });
  
  const req = http.request({
    hostname: '127.0.0.1',
    port: 9999,
    path: '/api/v1/message',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
    },
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      console.log('[E2E] Response status:', res.statusCode);
      console.log('[E2E] Response data:', data);
      resolve({ status: res.statusCode, data: data });
    });
  });
  req.on('error', reject);
  req.write(payload);
  req.end();
});

console.log('\n[E2E] === Test Summary ===');
console.log('[E2E] Daemon healthy:', health.status === 'healthy');
console.log('[E2E] Message sent:', result.status === 200 || result.status === 202);

if (result.status === 200 || result.status === 202) {
  console.log('[E2E] ✅ Test passed - message accepted by system');
} else {
  console.log('[E2E] ❌ Test failed - check daemon logs');
}
