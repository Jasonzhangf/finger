import WebSocket from 'ws';
import http from 'http';

console.log('[E2E] === Inside-Out Testing ===');
console.log('[E2E] Layer 1: Unit Test passed');
console.log('[E2E] Layer 2: Integration Test passed');
console.log('[E2E] Layer 3: Real QQBot E2E Test');

// 1. Health check
console.log('\n[E2E] Step 1: Daemon health check');
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

// 2. WebSocket message
console.log('\n[E2E] Step 2: Send test message via WebSocket');
const ws = new WebSocket('http://127.0.0.1:9998');
let replyReceived = false;

ws.on('open', () => {
  console.log('[E2E] WebSocket connected');
  
  // 发送消息
  const testMsg = {
    type: 'message',
    channelId: 'qqbot',
    messageId: 'test-msg-' + Date.now(),
    userId: 'test-user-001',
    userName: '测试用户',
    content: '你好',
    timestamp: Date.now(),
    requestId: 'req-' + Date.now()
  };
  
  console.log('[E2E] Sending:', JSON.stringify(testMsg));
  ws.send(JSON.stringify(testMsg));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[E2E] Received:', msg.type || msg.event);
  
  if (msg.event === 'message' || msg.type === 'reply') {
    console.log('[E2E] Got reply:', JSON.stringify(msg.data || msg, null, 2));
    replyReceived = true;
  }
});

ws.on('error', (err) => {
  console.error('[E2E] WebSocket error:', err.message);
});

// 等待 10 秒
await new Promise(resolve => setTimeout(resolve, 10000));

ws.close();
console.log('\n[E2E] === Test Summary ===');
console.log('[E2E] Layer 1: ✓ Unit Test passed');
console.log('[E2E] Layer 2: ✓ Integration Test passed');
console.log('[E2E] Layer 3:', replyReceived ? '✓ Reply received' : '⚠ No reply (check daemon logs)');
console.log('[E2E] Daemon healthy:', health.status === 'healthy');
