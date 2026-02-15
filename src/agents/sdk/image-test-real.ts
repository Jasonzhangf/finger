import { IFlowClient } from '@iflow-ai/iflow-cli-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ImageTestResult {
  success: boolean;
  modelUsed: string;
  modelHasImageCapability: boolean;
  promptSent: boolean;
  responseReceived: boolean;
  error?: string;
  output?: string;
}

/**
 * 真实图像能力测试
 * 使用 kimi-k2.5 模型发送图片并验证响应
 */
export async function testImageCapability(): Promise<ImageTestResult> {
  const result: ImageTestResult = {
    success: false,
    modelUsed: '',
    modelHasImageCapability: false,
    promptSent: false,
    responseReceived: false,
  };

  const client = new IFlowClient({ autoStartProcess: true, permissionMode: 'auto' });
  
  try {
    await client.connect();

    // 获取模型列表
    const models = await client.config.get<{
      availableModels?: Array<{
        id: string;
        name?: string;
        description?: string;
        capabilities?: { thinking?: boolean; image?: boolean; audio?: boolean; video?: boolean };
      }>;
    }>('models');

    const available = models?.availableModels ?? [];
    
    // 选择 kimi-k2.5 或包含 kimi 的模型
    const kimiModel = available.find((m) => m.id === 'kimi-k2.5') 
      || available.find((m) => m.id.includes('kimi'));

    if (!kimiModel) {
      return { ...result, error: 'No kimi model available' };
    }

    result.modelUsed = kimiModel.id;
    result.modelHasImageCapability = !!kimiModel.capabilities?.image;

    // 设置模型
    await client.config.set('model', kimiModel.id);

    // 读取测试图片 (vite.svg 是真实 SVG 文件)
    const imagePath = path.resolve(__dirname, '../../../ui/public/vite.svg');
    if (!fs.existsSync(imagePath)) {
      return { ...result, error: `Test image not found: ${imagePath}` };
    }

    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');

    // 发送图片消息
    await client.sendMessage('请描述这张图片的内容', [
      { type: 'image', data: base64, mimeType: 'image/svg+xml' }
    ]);
    result.promptSent = true;

    // 接收响应
    let output = '';
    for await (const msg of client.receiveMessages()) {
      if (msg.type === 'assistant' && 'chunk' in msg && (msg as any).chunk?.text) {
        output += (msg as any).chunk.text;
      }
      if (msg.type === 'task_finish') {
        result.responseReceived = true;
        break;
      }
      if (msg.type === 'error') {
        const errMsg = (msg as any).message || 'Unknown error';
        // 检查是否是格式不支持错误
        if (errMsg.includes('unsupported image format') || errMsg.includes('Invalid request')) {
          return { 
            ...result, 
            error: `Image format not supported by model: ${errMsg}`,
            responseReceived: true 
          };
        }
        return { ...result, error: errMsg, responseReceived: true };
      }
    }

    result.output = output.slice(0, 500);
    result.success = output.length > 0 && !output.includes('错误');

  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    await client.disconnect();
  }

  return result;
}
