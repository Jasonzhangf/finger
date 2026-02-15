import { IFlowClient } from '@iflow-ai/iflow-cli-sdk';
import fs from 'node:fs';

async function main() {
  const client = new IFlowClient({ autoStartProcess: true, permissionMode: 'auto' });
  await client.connect();

  try {
    // 选择 kimi-k2.5 模型（支持视觉）
    await client.config.set('model', 'kimi-k2.5');
    console.log('selected model: kimi-k2.5');

    // 使用一个本地 PNG 图像
    const pngPath = '/Volumes/extension/code/finger/ui/src/assets/react.svg';
    const imageData = fs.readFileSync(pngPath);
    const base64 = imageData.toString('base64');

    // 构造图片提示
    await client.sendMessage('请识别这张图片的内容。', [
      { type: 'image', data: base64, mimeType: 'image/svg+xml' }
    ]);

    let output = '';
    for await (const msg of client.receiveMessages()) {
      if (msg.type === 'assistant' && msg.chunk?.text) {
        output += msg.chunk.text;
        process.stdout.write(msg.chunk.text);
      }
      if (msg.type === 'task_finish') break;
      if (msg.type === 'error') {
        throw new Error(msg.message);
      }
    }

    console.log('\n\n[完成] 输出长度:', output.length);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error('ERR', e?.message || e);
  process.exit(1);
});
