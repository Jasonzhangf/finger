#!/usr/bin/env python3
"""
RouteCodex单元测试生成器
基于失败payload生成针对性的单元测试用例
"""

import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional
import argparse
import re

class TestGenerator:
    def __init__(self, project_root: str = None):
        self.project_root = Path(project_root or "../../routecodex-worktree/fix")
        self.test_output_dir = self.project_root / "tests" / "generated"
        self.templates = {
            'tool_error': self.get_tool_error_template(),
            'sse_error': self.get_sse_error_template(),
            'format_error': self.get_format_error_template(),
            'auth_error': self.get_auth_error_template(),
            'rate_limit': self.get_rate_limit_template()
        }

    def get_tool_error_template(self) -> str:
        """工具错误测试模板"""
        return '''import { describe, it, expect, beforeEach } from '@jest/globals';
import { LLMSwitchCore } from '../../src/modules/pipeline/modules/llmswitch-core';

describe('工具处理修复验证', () => {
  let llmSwitch: LLMSwitchCore;

  beforeEach(() => {
    llmSwitch = new LLMSwitchCore();
  });

  it('应该正确处理工具规范化', async () => {
    const payload = {tool_payload};

    const result = await llmSwitch.processTools(payload);

    expect(result).toBeDefined();
    expect(result.tools).toBeDefined();
    expect(result.errors).toBeUndefined();
  });

  it('应该正确处理工具调用', async () => {
    const payload = {tool_payload};

    const result = await llmSwitch.executeToolCall(payload);

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
  });

  it('应该正确处理工具收割', async () => {
    const payload = {tool_payload};

    const result = await llmSwitch.harvestToolResults(payload);

    expect(result).toBeDefined();
    expect(result.harvested).toBe(true);
  });
});
'''

    def get_sse_error_template(self) -> str:
        """SSE错误测试模板"""
        return '''import { describe, it, expect, beforeEach } from '@jest/globals';
import { StreamingController } from '../../src/modules/pipeline/modules/streaming-controller';

describe('SSE流式传输修复验证', () => {
  let controller: StreamingController;

  beforeEach(() => {
    controller = new StreamingController();
  });

  it('应该正确建立SSE连接', async () => {
    const payload = {sse_payload};

    const connection = await controller.createStream(payload);

    expect(connection).toBeDefined();
    expect(connection.active).toBe(true);
  });

  it('应该正确处理流式数据', async () => {
    const payload = {sse_payload};

    const chunks = [];
    const stream = controller.processStream(payload);

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toHaveProperty('content');
  });

  it('应该正确处理流式中断', async () => {
    const payload = {sse_payload};

    const result = await controller.handleStreamInterruption(payload);

    expect(result.recovered).toBe(true);
    expect(result.data).toBeDefined();
  });
});
'''

    def get_format_error_template(self) -> str:
        """格式错误测试模板"""
        return '''import { describe, it, expect, beforeEach } from '@jest/globals';
import { CompatibilityLayer } from '../../src/modules/pipeline/modules/compatibility';

describe('格式转换修复验证', () => {
  let compatibility: CompatibilityLayer;

  beforeEach(() => {
    compatibility = new CompatibilityLayer();
  });

  it('应该正确转换OpenAI格式', async () => {
    const payload = {format_payload};

    const result = await compatibility.transformOpenAIRequest(payload);

    expect(result).toBeDefined();
    expect(result.model).toBeDefined();
    expect(result.messages).toBeDefined();
  });

  it('应该正确映射字段', async () => {
    const payload = {format_payload};

    const result = await compatibility.mapFields(payload);

    expect(result).toBeDefined();
    expect(result.mappedFields).toBe(true);
  });

  it('应该正确验证格式', async () => {
    const payload = {format_payload};

    const validation = await compatibility.validateFormat(payload);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});
'''

    def get_auth_error_template(self) -> str:
        """认证错误测试模板"""
        return '''import { describe, it, expect, beforeEach } from '@jest/globals';
import { ProviderAuth } from '../../src/modules/pipeline/modules/provider-auth';

describe('认证处理修复验证', () => {
  let auth: ProviderAuth;

  beforeEach(() => {
    auth = new ProviderAuth();
  });

  it('应该正确处理API密钥认证', async () => {
    const payload = {auth_payload};

    const result = await auth.authenticateWithApiKey(payload);

    expect(result.success).toBe(true);
    expect(result.token).toBeDefined();
  });

  it('应该正确刷新认证令牌', async () => {
    const payload = {auth_payload};

    const result = await auth.refreshToken(payload);

    expect(result.success).toBe(true);
    expect(result.newToken).toBeDefined();
  });
});
'''

    def get_rate_limit_template(self) -> str:
        """频率限制错误测试模板"""
        return '''import { describe, it, expect, beforeEach } from '@jest/globals';
import { RateLimiter } from '../../src/modules/pipeline/modules/rate-limiter';

describe('频率限制修复验证', () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    rateLimiter = new RateLimiter();
  });

  it('应该正确实施频率限制', async () => {
    const payload = {rate_limit_payload};

    const result = await rateLimiter.checkLimit(payload);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
  });

  it('应该正确处理限制重置', async () => {
    const payload = {rate_limit_payload};

    const result = await rateLimiter.resetLimit(payload);

    expect(result.reset).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });
});
'''

    def analyze_error_type(self, payload_file: Path) -> str:
        """分析错误类型"""
        try:
            with open(payload_file, 'r') as f:
                payload = json.load(f)

            # 检查文件名中的错误类型
            filename = payload_file.name.lower()
            if 'tool' in filename or 'tool' in str(payload).lower():
                return 'tool_error'
            elif 'stream' in filename or 'sse' in str(payload).lower():
                return 'sse_error'
            elif 'format' in filename or 'parse' in str(payload).lower():
                return 'format_error'
            elif 'auth' in filename or 'unauthorized' in str(payload).lower():
                return 'auth_error'
            elif 'rate' in filename or '429' in str(payload).lower():
                return 'rate_limit'
            else:
                return 'tool_error'  # 默认类型

        except:
            return 'tool_error'

    def extract_payload_data(self, payload_file: Path) -> Dict[str, Any]:
        """提取payload数据"""
        try:
            with open(payload_file, 'r') as f:
                data = json.load(f)

            # 提取相关的payload数据
            if 'body' in data and isinstance(data['body'], str):
                return json.loads(data['body'])
            elif 'request' in data:
                return data['request']
            else:
                return data

        except:
            return {}

    def generate_test_file(self, error_type: str, payload_data: Dict[str, Any], output_file: Path):
        """生成测试文件"""
        template = self.templates.get(error_type, self.templates['tool_error'])

        # 替换模板中的占位符
        test_content = template.replace(
            '{tool_payload}',
            json.dumps(payload_data, indent=2, ensure_ascii=False)
        ).replace(
            '{sse_payload}',
            json.dumps(payload_data, indent=2, ensure_ascii=False)
        ).replace(
            '{format_payload}',
            json.dumps(payload_data, indent=2, ensure_ascii=False)
        ).replace(
            '{auth_payload}',
            json.dumps(payload_data, indent=2, ensure_ascii=False)
        ).replace(
            '{rate_limit_payload}',
            json.dumps(payload_data, indent=2, ensure_ascii=False)
        )

        # 确保输出目录存在
        output_file.parent.mkdir(parents=True, exist_ok=True)

        # 写入测试文件
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(test_content)

        return output_file

    def generate_tests_from_error(self, error_id: str, payload_file: Path, output_dir: Path = None):
        """基于错误生成测试"""
        if output_dir is None:
            output_dir = self.test_output_dir

        # 分析错误类型
        error_type = self.analyze_error_type(payload_file)

        # 提取payload数据
        payload_data = self.extract_payload_data(payload_file)

        # 生成测试文件名
        test_filename = f"{error_type}_{error_id}.test.ts"
        test_file = output_dir / test_filename

        # 生成测试文件
        generated_file = self.generate_test_file(error_type, payload_data, test_file)

        return {
            'error_id': error_id,
            'error_type': error_type,
            'payload_file': str(payload_file),
            'test_file': str(generated_file),
            'payload_size': len(json.dumps(payload_data))
        }

    def generate_batch_tests(self, payload_dir: Path, pattern: str = "*error*.json"):
        """批量生成测试"""
        results = []

        # 查找所有错误payload文件
        error_files = list(payload_dir.glob(pattern))

        for payload_file in error_files:
            # 从文件名提取错误ID
            error_id = self.extract_error_id(payload_file.name)

            if error_id:
                result = self.generate_tests_from_error(error_id, payload_file)
                results.append(result)

        return results

    def extract_error_id(self, filename: str) -> Optional[str]:
        """从文件名提取错误ID"""
        try:
            # 文件名格式: req_XXXXXXXX_requestId_type.json
            parts = filename.split('_')
            if len(parts) >= 3:
                return parts[2]
        except:
            pass
        return None

def main():
    parser = argparse.ArgumentParser(description='RouteCodex单元测试生成器')
    parser.add_argument('--error-id', '-e', type=str, help='错误ID')
    parser.add_argument('--payload', '-p', type=str, help='失败的payload文件路径')
    parser.add_argument('--payload-dir', '-d', type=str, help='payload目录路径')
    parser.add_argument('--output', '-o', type=str, help='输出目录路径')
    parser.add_argument('--project-root', '-r', type=str, help='项目根目录路径')

    args = parser.parse_args()

    generator = TestGenerator(args.project_root)

    if args.error_id and args.payload:
        # 生成单个测试
        payload_file = Path(args.payload)
        result = generator.generate_tests_from_error(args.error_id, payload_file)

        print(f"生成测试文件: {result['test_file']}")
        print(f"错误类型: {result['error_type']}")
        print(f"Payload大小: {result['payload_size']} 字节")

    elif args.payload_dir:
        # 批量生成测试
        payload_dir = Path(args.payload_dir)
        results = generator.generate_batch_tests(payload_dir)

        print(f"生成 {len(results)} 个测试文件:")
        for result in results:
            print(f"  - {result['test_file']} ({result['error_type']})")

    else:
        print("请指定 --error-id 和 --payload，或者 --payload-dir")
        sys.exit(1)

if __name__ == "__main__":
    main()