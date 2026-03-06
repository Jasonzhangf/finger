#!/usr/bin/env python3
"""
RouteCodex错误检测器
专门检测和分析RouteCodex流水线中的各类错误
"""

import json
import os
import sys
import re
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
from collections import defaultdict
import argparse

class ErrorDetector:
    def __init__(self, samples_dir: str = None):
        self.samples_dir = Path(samples_dir or os.path.expanduser("~/.routecodex/codex-samples"))
        self.error_patterns = {
            'sse_error': [
                r'stream.*error',
                r'sse.*fail',
                r'connection.*broken',
                r'stream.*interrupt'
            ],
            'tool_error': [
                r'tool.*execution.*fail',
                r'tool.*call.*error',
                r'invalid.*tool',
                r'tool.*timeout'
            ],
            'format_error': [
                r'format.*invalid',
                r'parse.*error',
                r'json.*invalid',
                r'schema.*error'
            ],
            'auth_error': [
                r'unauthorized',
                r'authentication.*fail',
                r'invalid.*api.*key',
                r'401'
            ],
            'rate_limit': [
                r'rate.*limit',
                r'too.*many.*requests',
                r'429'
            ],
            'network_error': [
                r'connection.*timeout',
                r'network.*error',
                r'host.*unreachable',
                r'dns.*error'
            ]
        }

    def scan_all_errors(self, limit: int = 20) -> Dict[str, Any]:
        """扫描所有错误"""
        all_files = []

        # 搜索所有日志目录
        for base_dir in ['openai-chat', 'openai-responses']:
            search_dir = self.samples_dir / base_dir
            if search_dir.exists():
                all_files.extend(list(search_dir.glob("*.json")))

        # 按时间排序，取最新的文件
        sorted_files = sorted(all_files, key=lambda f: f.stat().st_mtime, reverse=True)[:limit * 2]

        errors = []
        error_stats = defaultdict(int)

        for file_path in sorted_files:
            if len(errors) >= limit:
                break

            error_analysis = self.analyze_file_for_errors(file_path)
            if error_analysis['has_error']:
                errors.append(error_analysis)
                error_stats[error_analysis['error_type']] += 1

        return {
            'total_errors': len(errors),
            'error_types': dict(error_stats),
            'errors': errors
        }

    def analyze_file_for_errors(self, file_path: Path) -> Dict[str, Any]:
        """分析单个文件的错误"""
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)

            analysis = {
                'file': str(file_path),
                'timestamp': self.extract_timestamp(file_path.name),
                'has_error': False,
                'error_type': None,
                'error_details': None,
                'error_stage': self.detect_error_stage(file_path.name),
                'error_content': []
            }

            # 检查错误
            error_info = self.extract_error_info(data)
            if error_info:
                analysis.update(error_info)

            return analysis

        except Exception as e:
            return {
                'file': str(file_path),
                'has_error': True,
                'error_type': 'file_error',
                'error_details': f"文件解析错误: {str(e)}",
                'error_stage': self.detect_error_stage(file_path.name)
            }

    def extract_error_info(self, data: Any) -> Optional[Dict[str, Any]]:
        """提取错误信息"""
        if not isinstance(data, dict):
            return None

        # 检查直接错误字段
        for error_field in ['error', 'errors', 'exception']:
            if error_field in data and data[error_field]:
                error_data = data[error_field]
                error_text = self.extract_text_from_error(error_data)
                error_type = self.classify_error_type(error_text)

                return {
                    'has_error': True,
                    'error_type': error_type,
                    'error_details': error_text,
                    'error_content': [error_text]
                }

        # 检查HTTP状态码
        status = self.extract_status_code(data)
        if status and status >= 400:
            error_type = self.classify_http_error(status)
            return {
                'has_error': True,
                'error_type': error_type,
                'error_details': f"HTTP {status} 错误",
                'error_content': [f"HTTP {status}"]
            }

        # 检查响应体中的错误
        if 'response' in data and isinstance(data['response'], dict):
            response_error = self.extract_error_info(data['response'])
            if response_error:
                response_error['error_stage'] = 'response'
                return response_error

        # 检查请求体中的错误（如果是错误响应）
        if 'body' in data and isinstance(data['body'], str):
            try:
                body = json.loads(data['body'])
                body_error = self.extract_error_info(body)
                if body_error:
                    body_error['error_stage'] = 'request_body'
                    return body_error
            except:
                pass

        # 检查文本内容中的错误模式
        text_content = self.extract_all_text(data)
        for pattern_name, patterns in self.error_patterns.items():
            for pattern in patterns:
                if re.search(pattern, text_content, re.IGNORECASE):
                    return {
                        'has_error': True,
                        'error_type': pattern_name,
                        'error_details': f"匹配错误模式: {pattern}",
                        'error_content': [pattern]
                    }

        return None

    def extract_text_from_error(self, error_data: Any) -> str:
        """从错误数据中提取文本"""
        if isinstance(error_data, str):
            return error_data
        elif isinstance(error_data, dict):
            # 常见的错误字段
            for field in ['message', 'description', 'detail', 'error']:
                if field in error_data:
                    return str(error_data[field])

            # 如果没有找到，返回整个错误对象的字符串
            return json.dumps(error_data, ensure_ascii=False)
        elif isinstance(error_data, list):
            # 如果是列表，取第一个元素
            if error_data:
                return self.extract_text_from_error(error_data[0])

        return str(error_data)

    def extract_status_code(self, data: Dict) -> Optional[int]:
        """提取HTTP状态码"""
        for status_field in ['status', 'statusCode', 'status_code']:
            if status_field in data:
                return data[status_field]

        # 检查响应中的状态码
        if 'response' in data and isinstance(data['response'], dict):
            return self.extract_status_code(data['response'])

        return None

    def classify_error_type(self, error_text: str) -> str:
        """分类错误类型"""
        error_text_lower = error_text.lower()

        for pattern_name, patterns in self.error_patterns.items():
            for pattern in patterns:
                if re.search(pattern, error_text_lower):
                    return pattern_name

        # 基于关键词分类
        if any(keyword in error_text_lower for keyword in ['timeout', 'time out']):
            return 'timeout_error'
        elif any(keyword in error_text_lower for keyword in ['connection', 'network']):
            return 'network_error'
        elif any(keyword in error_text_lower for keyword in ['parse', 'json', 'format']):
            return 'format_error'
        elif any(keyword in error_text_lower for keyword in ['tool', 'function']):
            return 'tool_error'
        elif any(keyword in error_text_lower for keyword in ['stream', 'sse']):
            return 'sse_error'
        else:
            return 'unknown_error'

    def classify_http_error(self, status: int) -> str:
        """根据HTTP状态码分类错误"""
        if status == 400:
            return 'bad_request'
        elif status == 401:
            return 'auth_error'
        elif status == 403:
            return 'forbidden'
        elif status == 404:
            return 'not_found'
        elif status == 429:
            return 'rate_limit'
        elif 500 <= status < 600:
            return 'server_error'
        else:
            return 'http_error'

    def detect_error_stage(self, filename: str) -> str:
        """检测错误发生的阶段"""
        if 'pre' in filename:
            return 'llmswitch_workflow'
        elif 'post' in filename:
            return 'compatibility'
        elif 'finalize' in filename:
            return 'provider'
        elif 'snapshot' in filename:
            return 'snapshot'
        else:
            return 'unknown'

    def extract_all_text(self, data: Any) -> str:
        """提取所有文本内容"""
        if isinstance(data, str):
            return data
        elif isinstance(data, dict):
            texts = []
            for value in data.values():
                texts.append(self.extract_all_text(value))
            return ' '.join(texts)
        elif isinstance(data, list):
            texts = []
            for item in data:
                texts.append(self.extract_all_text(item))
            return ' '.join(texts)
        else:
            return str(data)

    def extract_timestamp(self, filename: str) -> Optional[int]:
        """提取时间戳"""
        try:
            parts = filename.split('_')
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1])
        except:
            pass
        return None

    def analyze_error_patterns(self, errors: List[Dict]) -> Dict[str, Any]:
        """分析错误模式"""
        pattern_analysis = {
            'by_type': defaultdict(list),
            'by_stage': defaultdict(list),
            'frequency': defaultdict(int),
            'recent_trends': []
        }

        for error in errors:
            error_type = error.get('error_type', 'unknown')
            error_stage = error.get('error_stage', 'unknown')
            timestamp = error.get('timestamp', 0)

            pattern_analysis['by_type'][error_type].append(error)
            pattern_analysis['by_stage'][error_stage].append(error)
            pattern_analysis['frequency'][error_type] += 1

        # 分析趋势
        recent_errors = sorted(errors, key=lambda e: e.get('timestamp', 0), reverse=True)[:10]
        pattern_analysis['recent_trends'] = [
            error.get('error_type', 'unknown') for error in recent_errors
        ]

        return pattern_analysis

    def suggest_fixes(self, error_type: str) -> List[str]:
        """根据错误类型建议修复方案"""
        suggestions = {
            'sse_error': [
                "检查llmswitch-core的流式处理逻辑",
                "验证SSE连接是否正确建立",
                "检查网络稳定性",
                "确认客户端是否正确处理流式数据"
            ],
            'tool_error': [
                "检查工具规范化器是否正确处理",
                "验证工具schema定义",
                "确认工具收割器完整性",
                "检查系统工具指引是否正确注入"
            ],
            'format_error': [
                "检查Compatibility层字段映射",
                "验证协议转换逻辑",
                "确认配置文件正确性",
                "检查JSON格式是否有效"
            ],
            'auth_error': [
                "检查Provider层认证配置",
                "验证API密钥有效性",
                "确认认证流程正确",
                "检查权限范围设置"
            ],
            'rate_limit': [
                "检查请求频率限制",
                "实现请求重试机制",
                "考虑增加缓存",
                "检查并发控制"
            ],
            'network_error': [
                "检查网络连接",
                "验证DNS解析",
                "检查防火墙设置",
                "增加超时时间"
            ]
        }

        return suggestions.get(error_type, ["检查日志获取更多详细信息", "联系技术支持"])

def main():
    parser = argparse.ArgumentParser(description='RouteCodex错误检测器')
    parser.add_argument('--limit', '-n', type=int, default=20, help='扫描的错误数量限制')
    parser.add_argument('--type', '-t', type=str, help='过滤特定错误类型')
    parser.add_argument('--stage', '-s', type=str, help='过滤特定错误阶段')
    parser.add_argument('--dir', '-d', type=str, help='自定义日志目录路径')

    args = parser.parse_args()

    detector = ErrorDetector(args.dir)

    print("=== RouteCodex错误检测 ===")
    scan_result = detector.scan_all_errors(args.limit)

    print(f"发现错误总数: {scan_result['total_errors']}")
    print("错误类型分布:")
    for error_type, count in scan_result['error_types'].items():
        print(f"  {error_type}: {count}")

    print("\n详细错误列表:")
    for i, error in enumerate(scan_result['errors'], 1):
        error_type = error.get('error_type', 'unknown')
        error_stage = error.get('error_stage', 'unknown')
        error_details = error.get('error_details', 'No details')

        print(f"\n{i}. {error_type} ({error_stage})")
        print(f"   文件: {error['file']}")
        print(f"   详情: {error_details}")

        # 提供修复建议
        suggestions = detector.suggest_fixes(error_type)
        if suggestions:
            print("   建议修复:")
            for suggestion in suggestions[:2]:  # 只显示前2个建议
                print(f"     • {suggestion}")

    # 错误模式分析
    pattern_analysis = detector.analyze_error_patterns(scan_result['errors'])
    print(f"\n=== 错误模式分析 ===")

    print("按阶段分布:")
    for stage, errors in pattern_analysis['by_stage'].items():
        print(f"  {stage}: {len(errors)} 个错误")

    if pattern_analysis['recent_trends']:
        print(f"\n最近错误趋势: {' → '.join(pattern_analysis['recent_trends'][:5])}")

if __name__ == "__main__":
    main()