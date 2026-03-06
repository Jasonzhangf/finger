#!/usr/bin/env python3
"""
RouteCodex日志分析器
分析~/.routecodex/codex-samples/目录下的请求/响应日志
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any, Optional
import argparse

class LogAnalyzer:
    def __init__(self, samples_dir: str = None):
        self.samples_dir = Path(samples_dir or os.path.expanduser("~/.routecodex/codex-samples"))
        self.openai_chat_dir = self.samples_dir / "openai-chat"
        self.openai_responses_dir = self.samples_dir / "openai-responses"

    def find_latest_logs(self, count: int = 10) -> List[Path]:
        """查找最新的日志文件"""
        all_files = []

        # 搜索openai-chat目录
        if self.openai_chat_dir.exists():
            all_files.extend(list(self.openai_chat_dir.glob("*.json")))

        # 搜索openai-responses目录
        if self.openai_responses_dir.exists():
            all_files.extend(list(self.openai_responses_dir.glob("*.json")))

        # 按修改时间排序，取最新的
        sorted_files = sorted(all_files, key=lambda f: f.stat().st_mtime, reverse=True)
        return sorted_files[:count]

    def analyze_request_file(self, file_path: Path) -> Dict[str, Any]:
        """分析单个请求文件"""
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)

            analysis = {
                'file': str(file_path),
                'timestamp': self.extract_timestamp(file_path.name),
                'type': self.detect_file_type(file_path.name),
                'has_error': self.detect_error(data),
                'is_streaming': self.detect_streaming(data),
                'has_tools': self.detect_tools(data),
                'model_info': self.extract_model_info(data),
                'status_code': self.extract_status_code(data),
                'request_id': self.extract_request_id(data)
            }

            return analysis

        except Exception as e:
            return {
                'file': str(file_path),
                'error': str(e),
                'timestamp': self.extract_timestamp(file_path.name)
            }

    def detect_file_type(self, filename: str) -> str:
        """检测文件类型"""
        if 'pre' in filename:
            return 'pre-processing'
        elif 'post' in filename:
            return 'post-processing'
        elif 'finalize' in filename:
            return 'finalize'
        elif 'snapshot' in filename:
            return 'snapshot'
        else:
            return 'unknown'

    def detect_error(self, data: Dict) -> bool:
        """检测是否包含错误"""
        if isinstance(data, dict):
            # 检查常见的错误字段
            error_fields = ['error', 'errors', 'exception', 'fail']
            for field in error_fields:
                if field in data and data[field]:
                    return True

            # 检查HTTP状态码
            if 'status' in data and data['status'] >= 400:
                return True

            # 检查响应中的错误
            if 'response' in data and isinstance(data['response'], dict):
                if 'status' in data['response'] and data['response']['status'] >= 400:
                    return True

        return False

    def detect_streaming(self, data: Dict) -> bool:
        """检测是否为流式请求"""
        if isinstance(data, dict):
            # 检查请求体中的stream字段
            if 'body' in data and isinstance(data['body'], str):
                try:
                    body = json.loads(data['body'])
                    if body.get('stream', False):
                        return True
                except:
                    pass

            # 检查配置中的stream设置
            if 'stream' in data and data['stream']:
                return True

        return False

    def detect_tools(self, data: Dict) -> bool:
        """检测是否包含工具调用"""
        if isinstance(data, dict):
            # 检查请求体中的tools字段
            if 'body' in data and isinstance(data['body'], str):
                try:
                    body = json.loads(data['body'])
                    if 'tools' in body and body['tools']:
                        return True
                    if 'messages' in body:
                        for msg in body['messages']:
                            if 'tool_calls' in msg and msg['tool_calls']:
                                return True
                except:
                    pass

        return False

    def extract_model_info(self, data: Dict) -> Optional[str]:
        """提取模型信息"""
        if isinstance(data, dict):
            # 从请求体中提取
            if 'body' in data and isinstance(data['body'], str):
                try:
                    body = json.loads(data['body'])
                    if 'model' in body:
                        return body['model']
                except:
                    pass

            # 从响应中提取
            if 'response' in data and isinstance(data['response'], dict):
                resp_body = data['response'].get('body', '{}')
                try:
                    resp = json.loads(resp_body)
                    if 'model' in resp:
                        return resp['model']
                except:
                    pass

        return None

    def extract_status_code(self, data: Dict) -> Optional[int]:
        """提取HTTP状态码"""
        if isinstance(data, dict):
            # 直接状态码
            if 'status' in data:
                return data['status']

            # 响应中的状态码
            if 'response' in data and isinstance(data['response'], dict):
                if 'status' in data['response']:
                    return data['response']['status']

        return None

    def extract_request_id(self, data: Dict) -> Optional[str]:
        """提取请求ID"""
        if isinstance(data, dict):
            # 常见的ID字段
            id_fields = ['requestId', 'request_id', 'id', 'request-id']
            for field in id_fields:
                if field in data:
                    return data[field]

            # 从header中提取
            if 'headers' in data and isinstance(data['headers'], dict):
                for key, value in data['headers'].items():
                    if 'request-id' in key.lower():
                        return value

        return None

    def extract_timestamp(self, filename: str) -> Optional[datetime]:
        """从文件名提取时间戳"""
        try:
            # 文件名格式: req_XXXXXXXXXXXX_id_type.json
            parts = filename.split('_')
            if len(parts) >= 2 and parts[1].isdigit():
                timestamp = int(parts[1])
                return datetime.fromtimestamp(timestamp / 1000)
        except:
            pass

        return None

    def analyze_latest_requests(self, count: int = 10) -> Dict[str, Any]:
        """分析最新的请求"""
        latest_files = self.find_latest_logs(count)

        results = []
        error_count = 0
        streaming_count = 0
        tools_count = 0

        for file_path in latest_files:
            analysis = self.analyze_request_file(file_path)
            results.append(analysis)

            if analysis.get('has_error', False):
                error_count += 1
            if analysis.get('is_streaming', False):
                streaming_count += 1
            if analysis.get('has_tools', False):
                tools_count += 1

        summary = {
            'total_files': len(results),
            'error_count': error_count,
            'streaming_count': streaming_count,
            'tools_count': tools_count,
            'error_rate': error_count / len(results) if results else 0,
            'analysis': results
        }

        return summary

    def find_errors(self, limit: int = 5) -> List[Dict[str, Any]]:
        """查找最近的错误"""
        all_files = []

        # 搜索所有目录
        for directory in [self.openai_chat_dir, self.openai_responses_dir]:
            if directory.exists():
                all_files.extend(list(directory.glob("*.json")))

        # 按时间排序
        sorted_files = sorted(all_files, key=lambda f: f.stat().st_mtime, reverse=True)

        errors = []
        for file_path in sorted_files:
            if len(errors) >= limit:
                break

            analysis = self.analyze_request_file(file_path)
            if analysis.get('has_error', False):
                errors.append(analysis)

        return errors

def main():
    parser = argparse.ArgumentParser(description='RouteCodex日志分析器')
    parser.add_argument('--count', '-n', type=int, default=10, help='分析的日志文件数量')
    parser.add_argument('--errors', '-e', action='store_true', help='只显示错误')
    parser.add_argument('--dir', '-d', type=str, help='自定义日志目录路径')

    args = parser.parse_args()

    analyzer = LogAnalyzer(args.dir)

    if args.errors:
        print("=== 查找最近的错误 ===")
        errors = analyzer.find_errors()

        if not errors:
            print("未发现错误")
        else:
            for i, error in enumerate(errors, 1):
                print(f"\n错误 {i}:")
                print(f"  文件: {error['file']}")
                print(f"  时间: {error['timestamp']}")
                print(f"  类型: {error['type']}")
                if 'status_code' in error:
                    print(f"  状态码: {error['status_code']}")
                if 'request_id' in error:
                    print(f"  请求ID: {error['request_id']}")
    else:
        print(f"=== 分析最近 {args.count} 个请求 ===")
        summary = analyzer.analyze_latest_requests(args.count)

        print(f"总文件数: {summary['total_files']}")
        print(f"错误数: {summary['error_count']}")
        print(f"错误率: {summary['error_rate']:.2%}")
        print(f"流式请求数: {summary['streaming_count']}")
        print(f"工具请求数: {summary['tools_count']}")

        print("\n详细分析:")
        for i, analysis in enumerate(summary['analysis'], 1):
            print(f"\n{i}. {analysis['file']}")
            print(f"   时间: {analysis['timestamp']}")
            print(f"   类型: {analysis['type']}")
            if analysis.get('model_info'):
                print(f"   模型: {analysis['model_info']}")
            if analysis.get('has_error'):
                print(f"   ❌ 包含错误")
            if analysis.get('is_streaming'):
                print(f"   🌊 流式请求")
            if analysis.get('has_tools'):
                print(f"   🔧 包含工具")

if __name__ == "__main__":
    main()