import { IFlowClient } from '@iflow-ai/iflow-cli-sdk';
import fs from 'node:fs';

async function main() {
  const client = new IFlowClient({ autoStartProcess: true, permissionMode: 'auto' });
  await client.connect();

  try {
    const models = await client.config.get('models');
    console.log('models:', JSON.stringify(models, null, 2));

    const available = models?.availableModels || [];
    const preferred = available.find((m) => String(m.id || '').includes('iflow.kimi-k2.5'))
      || available.find((m) => String(m.id || '').includes('kimi'));

    if (preferred?.id) {
      await client.config.set('model', preferred.id);
      console.log('selected model:', preferred.id, 'capabilities:', preferred.capabilities || {});
    }

    // 使用一个本地 png 测试图像输入
    const pngPath = '/Volumes/extension/code/finger/ui/public/vite.svg';
    const pngBase64 = fs.readFileSync(pngPath).toString('base64');

    await client.sendMessage('请识别这张图片内容并简述。', [
      { type: 'image', data: pngBase64, mimeType: 'image/svg+xml' }
    ]);

    let output = '';
    for await (const msg of client.receiveMessages()) {
      if (msg.type === 'assistant' && msg.chunk?.text) {
        output += msg.chunk.text;
      }
      if (msg.type === 'task_finish') break;
      if (msg.type === 'error') {
        throw new Error(msg.message);
      }
    }

    console.log('assistant_output:', output.slice(0, 500));
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error('ERR', e?.message || e);
  process.exit(1);
});
