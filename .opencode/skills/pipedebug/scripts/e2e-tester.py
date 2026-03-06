#!/usr/bin/env python3
"""
RouteCodex端到端测试工具
使用真实payload测试完整功能
"""

import json
import os
import sys
import time
import asyncio
import aiohttp
import subprocess
from pathlib import Path
from typing import Dict, List, Any, Optional
import argparse
from datetime import datetime

class E2ETester:
    def __init__(self, project_root: str = None, base_url: str = "http://localhost:5506"):
        self.project_root = Path(project_root or "../../routecodex-worktree/fix")
        self.base_url = base_url
        self.test_results = {
            'total_tests': 0,
            'passed_tests': 0,
            'failed_tests': 0,
            'skipped_tests': 0,
            'test_details': [],
            'start_time': None,
            'end_time': None,
            'duration': None
        }

    async def check_service_health(self) -> bool:
        """检查服务健康状态"""
        try:
            health_url = f"{self.base_url}/api/health"

            async with aiohttp.ClientSession() as session:
                async with session.get(health_url, timeout=10) as response:
                    if response.status == 200:
                        data = await response.json()
                        print(f"✅ 服务健康: {data}")
                        return True
                    else:
                        print(f"❌ 服务不健康，状态码: {response.status}")
                        return False

        except Exception as e:
            print(f"❌ 无法连接到服务: {e}")
            return False

    def load_payload(self, payload_file: Path) -> Optional[Dict[str, Any]]:
        """加载payload"""
        try:
            with open(payload_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # 提取请求体
            if 'body' in data and isinstance(data['body'], str):
                return json.loads(data['body'])
            elif 'request' in data:
                return data['request']
            else:
                return data

        except Exception as e:
            print(f"❌ 加载payload失败 {payload_file}: {e}")
            return None

    async def send_request(self, payload: Dict[str, Any], endpoint: str = "/v1/chat") -> Dict[str, Any]:
        """发送请求"""
        headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-key'  # 测试用认证
        }

        url = f"{self.base_url}{endpoint}"

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload, headers=headers, timeout=30) as response:
                    response_text = await response.text()

                    return {
                        'status_code': response.status,
                        'headers': dict(response.headers),
                        'body': response_text,
                        'success': response.status < 400
                    }

        except asyncio.TimeoutError:
            return {
                'status_code': 0,
                'headers': {},
                'body': 'Request timeout',
                'success': False
            }

        except Exception as e:
            return {
                'status_code': 0,
                'headers': {},
                'body': str(e),
                'success': False
            }

    def analyze_response(self, payload: Dict[str, Any], response: Dict[str, Any]) -> Dict[str, Any]:
        """分析响应"""
        analysis = {
            'request_success': response['success'],
            'status_code': response['status_code'],
            'has_content': bool(response['body']),
            'is_json': False,
            'has_error': False,
            'error_details': None,
            'response_time': response.get('response_time', 0),
            'content_length': len(response['body']) if response['body'] else 0
        }

        # 检查是否为JSON响应
        try:
            json.loads(response['body'])
            analysis['is_json'] = True
        except:
            pass

        # 检查错误
        if not response['success']:
            analysis['has_error'] = True
            analysis['error_details'] = response['body']

        # 检查流式响应
        if 'stream' in payload and payload.get('stream'):
            analysis['is_streaming'] = True
            analysis['stream_chunks'] = self.count_stream_chunks(response['body'])

        return analysis

    def count_stream_chunks(self, body: str) -> int:
        """计算流式响应块数"""
        if not body:
            return 0

        # 计算SSE数据块数量
        chunks = body.split('\n\n')
        return len([chunk for chunk in chunks if chunk.strip()])

    async def test_single_payload(self, payload_file: Path) -> Dict[str, Any]:
        """测试单个payload"""
        print(f"🧪 测试: {payload_file.name}")

        test_result = {
            'payload_file': str(payload_file),
            'timestamp': datetime.now().isoformat(),
            'success': False,
            'request_success': False,
            'status_code': None,
            'error': None,
            'analysis': {}
        }

        try:
            # 加载payload
            payload = self.load_payload(payload_file)
            if payload is None:
                test_result['error'] = "Failed to load payload"
                return test_result

            # 发送请求
            start_time = time.time()
            response = await self.send_request(payload)
            response['response_time'] = time.time() - start_time

            # 分析响应
            analysis = self.analyze_response(payload, response)

            test_result.update({
                'request_success': response['success'],
                'status_code': response['status_code'],
                'analysis': analysis
            })

            # 判断测试是否成功
            # 原本失败的请求现在成功了，或者响应质量明显改善
            if response['success'] and not analysis.get('has_error'):
                test_result['success'] = True
                print(f"✅ 测试通过 - 状态码: {response['status_code']}")
            else:
                test_result['error'] = analysis.get('error_details', 'Unknown error')
                print(f"❌ 测试失败 - {test_result['error']}")

        except Exception as e:
            test_result['error'] = str(e)
            print(f"❌ 测试异常: {e}")

        return test_result

    def find_payload_files(self, payload_dir: Path, pattern: str = "*.json") -> List[Path]:
        """查找payload文件"""
        if not payload_dir.exists():
            print(f"❌ 目录不存在: {payload_dir}")
            return []

        files = list(payload_dir.glob(pattern))
        print(f"📁 找到 {len(files)} 个payload文件")
        return files

    def print_summary(self):
        """打印测试摘要"""
        self.test_results['end_time'] = datetime.now()
        if self.test_results['start_time']:
            self.test_results['duration'] = (
                self.test_results['end_time'] - self.test_results['start_time']
            ).total_seconds()

        total = self.test_results['total_tests']
        passed = self.test_results['passed_tests']
        failed = self.test_results['failed_tests']

        print("\n" + "="*60)
        print("📊 端到端测试报告")
        print("="*60)

        if self.test_results['duration']:
            print(f"⏱️  总耗时: {self.test_results['duration']:.2f}秒")

        print(f"📈 测试统计:")
        print(f"  总测试数: {total}")
        print(f"  通过: {passed} ({passed/total*100:.1f}%)" if total > 0 else "  通过: 0")
        print(f"  失败: {failed} ({failed/total*100:.1f}%)" if total > 0 else "  失败: 0")

        print("\n" + "="*60)
        if failed == 0:
            print("🎉 所有端到端测试通过！")
        else:
            print(f"❌ {failed} 个测试失败，需要进一步调试")
        print("="*60)

    async def run_e2e_tests(self, payload_files: List[Path]) -> bool:
        """运行端到端测试"""
        self.test_results['start_time'] = datetime.now()

        print("🚀 开始端到端测试...")

        # 检查服务状态
        if not await self.check_service_health():
            print("❌ 服务不可用，测试终止")
            return False

        # 运行测试
        for payload_file in payload_files:
            result = await self.test_single_payload(payload_file)
            self.test_results['test_details'].append(result)

            # 更新统计
            self.test_results['total_tests'] += 1
            if result['success']:
                self.test_results['passed_tests'] += 1
            else:
                self.test_results['failed_tests'] += 1

        return self.test_results['failed_tests'] == 0

async def main():
    parser = argparse.ArgumentParser(description='RouteCodex端到端测试工具')
    parser.add_argument('--payload', '-p', type=str, help='单个payload文件路径')
    parser.add_argument('--payload-dir', '-d', type=str, help='payload目录路径')
    parser.add_argument('--base-url', '-u', type=str, default='http://localhost:5506', help='服务基础URL')
    parser.add_argument('--project-root', '-r', type=str, help='项目根目录路径')
    parser.add_argument('--test-count', '-n', type=int, default=10, help='测试文件数量限制')
    parser.add_argument('--pattern', type=str, default='*.json', help='文件匹配模式')

    args = parser.parse_args()

    tester = E2ETester(args.project_root, args.base_url)

    # 查找测试文件
    payload_files = []

    if args.payload:
        payload_file = Path(args.payload)
        if payload_file.exists():
            payload_files.append(payload_file)
        else:
            print(f"❌ 文件不存在: {payload_file}")
            sys.exit(1)
    elif args.payload_dir:
        payload_dir = Path(args.payload_dir)
        payload_files = tester.find_payload_files(payload_dir, args.pattern)
        payload_files = payload_files[:args.test_count]  # 限制数量
    else:
        print("请指定 --payload 或 --payload-dir")
        sys.exit(1)

    if not payload_files:
        print("❌ 未找到测试文件")
        sys.exit(1)

    # 运行测试
    success = await tester.run_e2e_tests(payload_files)

    # 打印摘要
    tester.print_summary()

    sys.exit(0 if success else 1)

if __name__ == "__main__":
    asyncio.run(main())