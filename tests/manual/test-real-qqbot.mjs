import WebSocket from 'ws';

const ws = new WebSocket('http://127.0.0.1:9998');

ws.on('open', () => {
  console.log('[Manual] WebSocket connected to main daemon');
  
  ws.send(JSON.stringify({
    type: 'start',
    channelId: 'qqbot',
    requestId: 'start-manual-' + Date.now()
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[Manual] Received:', JSON.stringify(msg, null, 2));
  
  if (msg.ok && msg.result?.starting) {
    setTimeout(() => {
      console.log('[Manual] Sending test message...');
      ws.send(JSON.stringify({
        type: 'message',
        channelId: 'qqbot',
        messageId: 'msg-manual-' + Date.now(),
        userId: 'test-user-real',
        userName: '真实测试用户',
        content: '你好，帮我检查项目状态',
        timestamp: Date.now(),
        requestId: 'send-manual-' + Date.now()
      }));
    }, 1000);
  }
  
  if (msg.requestId?.startsWith('send-')) {
    console.log('[Manual] Message response:', JSON.stringify(msg, null, 2));
    setTimeout(() => {
      console.log('[Manual] Test complete, closing connection');
      ws.close();
      process.exit(0);
    }, 3000);
  }
});

ws.on('error', (err) => {
  console.error('[Manual] WebSocket error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('[Manual] Timeout, closing...');
  ws.close();
  process.exit(0);
}, 15000);
