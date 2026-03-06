#!/usr/bin/env python3
"""
RouteCodex流水线追踪器
追踪请求在4层流水线中的处理过程
"""

import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional
from collections import defaultdict
import argparse

class PipelineTracer:
    def __init__(self, samples_dir: str = None):
        self.samples_dir = Path(samples_dir or os.path.expanduser("~/.routecodex/codex-samples"))
        self.pipeline_layers = [
            'llmswitch-workflow',
            'compatibility',
            'provider',
            'external-service'
        ]

    def group_by_request_id(self, files: List[Path]) -> Dict[str, List[Path]]:
        """按请求ID分组文件"""
        grouped = defaultdict(list)

        for file_path in files:
            request_id = self.extract_request_id_from_filename(file_path.name)
            if request_id:
                grouped[request_id].append(file_path)

        return grouped

    def extract_request_id_from_filename(self, filename: str) -> Optional[str]:
        """从文件名提取请求ID"""
        try:
            # 文件名格式: req_XXXXXXXXXXXX_requestId_type.json
            parts = filename.split('_')
            if len(parts) >= 3:
                return parts[2]
        except:
            pass
        return None

    def trace_request_pipeline(self, request_id: str) -> Dict[str, Any]:
        """追踪单个请求的流水线处理过程"""
        # 查找相关文件
        request_files = self.find_request_files(request_id)

        if not request_files:
            return {'error': f'未找到请求ID {request_id} 的文件'}

        trace = {
            'request_id': request_id,
            'files': [],
            'pipeline_flow': [],
            'errors': [],
            'transformations': []
        }

        # 按处理阶段排序文件
        sorted_files = self.sort_files_by_stage(request_files)

        for file_path in sorted_files:
            file_analysis = self.analyze_pipeline_file(file_path)
            trace['files'].append(file_analysis)

            # 分析流水线流向
            stage = self.detect_pipeline_stage(file_path.name, file_analysis)
            if stage:
                trace['pipeline_flow'].append({
                    'stage': stage,
                    'file': str(file_path),
                    'timestamp': file_analysis.get('timestamp'),
                    'status': file_analysis.get('status', 'unknown')
                })

            # 检测错误
            if file_analysis.get('has_error'):
                trace['errors'].append({
                    'stage': stage,
                    'file': str(file_path),
                    'error_details': file_analysis.get('error_details')
                })

            # 检测数据转换
            transformations = self.detect_transformations(file_analysis)
            if transformations:
                trace['transformations'].extend(transformations)

        return trace

    def find_request_files(self, request_id: str) -> List[Path]:
        """查找特定请求的所有文件"""
        all_files = []

        # 在所有目录中搜索
        for base_dir in ['openai-chat', 'openai-responses']:
            search_dir = self.samples_dir / base_dir
            if search_dir.exists():
                pattern = f"*{request_id}*.json"
                all_files.extend(list(search_dir.glob(pattern)))

        return all_files

    def sort_files_by_stage(self, files: List[Path]) -> List[Path]:
        """按处理阶段排序文件"""
        stage_order = {
            'pre': 1,
            'snapshot': 2,
            'post': 3,
            'finalize': 4
        }

        def get_stage_order(filename):
            for stage, order in stage_order.items():
                if stage in filename:
                    return order
            return 999

        return sorted(files, key=lambda f: get_stage_order(f.name))

    def analyze_pipeline_file(self, file_path: Path) -> Dict[str, Any]:
        """分析流水线文件"""
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)

            analysis = {
                'file': str(file_path),
                'stage': self.detect_file_stage(file_path.name),
                'timestamp': self.extract_timestamp(file_path.name),
                'has_error': self.detect_error(data),
                'size': len(json.dumps(data)),
                'data_keys': list(data.keys()) if isinstance(data, dict) else []
            }

            # 分析特定阶段的信息
            if analysis['stage'] == 'pre':
                analysis.update(self.analyze_pre_processing(data))
            elif analysis['stage'] == 'post':
                analysis.update(self.analyze_post_processing(data))
            elif analysis['stage'] == 'finalize':
                analysis.update(self.analyze_finalize(data))

            return analysis

        except Exception as e:
            return {
                'file': str(file_path),
                'error': str(e),
                'stage': self.detect_file_stage(file_path.name)
            }

    def detect_file_stage(self, filename: str) -> str:
        """检测文件处理阶段"""
        if 'pre' in filename:
            return 'pre'
        elif 'post' in filename:
            return 'post'
        elif 'finalize' in filename:
            return 'finalize'
        elif 'snapshot' in filename:
            return 'snapshot'
        else:
            return 'unknown'

    def detect_pipeline_stage(self, filename: str, analysis: Dict) -> Optional[str]:
        """检测文件对应的流水线阶段"""
        file_stage = analysis.get('stage')

        # 基于文件类型和处理阶段推断流水线阶段
        if file_stage == 'pre':
            return 'llmswitch-workflow'
        elif file_stage == 'post':
            return 'compatibility'
        elif file_stage == 'finalize':
            return 'provider'

        return None

    def analyze_pre_processing(self, data: Dict) -> Dict[str, Any]:
        """分析预处理阶段"""
        result = {}

        if isinstance(data, dict):
            # 检查工具规范化
            if 'body' in data:
                try:
                    body = json.loads(data['body'])
                    if 'tools' in body:
                        result['tools_count'] = len(body['tools'])
                        result['has_tools'] = True

                    if 'stream' in body:
                        result['is_streaming'] = body['stream']
                except:
                    pass

            # 检查llmswitch处理
            if 'llmswitch' in data:
                result['llmswitch_processed'] = True

        return result

    def analyze_post_processing(self, data: Dict) -> Dict[str, Any]:
        """分析后处理阶段"""
        result = {}

        if isinstance(data, dict):
            # 检查兼容性处理
            if 'compatibility' in data:
                result['compatibility_applied'] = True

            # 检查字段映射
            if 'field_mapping' in data:
                result['field_mapping_applied'] = True

        return result

    def analyze_finalize(self, data: Dict) -> Dict[str, Any]:
        """分析最终处理阶段"""
        result = {}

        if isinstance(data, dict):
            # 检查Provider处理结果
            if 'provider' in data:
                result['provider_processed'] = True

            # 检查HTTP响应状态
            if 'status' in data:
                result['http_status'] = data['status']

            # 检查最终响应
            if 'response' in data:
                result['final_response'] = True

        return result

    def detect_error(self, data: Dict) -> bool:
        """检测错误"""
        if isinstance(data, dict):
            error_fields = ['error', 'errors', 'exception']
            for field in error_fields:
                if field in data and data[field]:
                    return True

            # 检查HTTP错误状态码
            if 'status' in data and data['status'] >= 400:
                return True

        return False

    def detect_transformations(self, analysis: Dict) -> List[Dict[str, Any]]:
        """检测数据转换"""
        transformations = []

        # 基于文件阶段检测转换
        stage = analysis.get('stage')
        if stage == 'pre' and analysis.get('has_tools'):
            transformations.append({
                'type': 'tool_normalization',
                'stage': 'llmswitch-workflow',
                'description': '工具规范化处理'
            })

        if stage == 'post' and analysis.get('field_mapping_applied'):
            transformations.append({
                'type': 'field_mapping',
                'stage': 'compatibility',
                'description': '字段映射转换'
            })

        if stage == 'finalize' and analysis.get('provider_processed'):
            transformations.append({
                'type': 'provider_communication',
                'stage': 'provider',
                'description': 'Provider通信处理'
            })

        return transformations

    def extract_timestamp(self, filename: str) -> Optional[int]:
        """提取时间戳"""
        try:
            parts = filename.split('_')
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1])
        except:
            pass
        return None

    def trace_latest_requests(self, count: int = 5) -> List[Dict[str, Any]]:
        """追踪最新的几个请求"""
        # 获取最新文件
        all_files = []
        for base_dir in ['openai-chat', 'openai-responses']:
            search_dir = self.samples_dir / base_dir
            if search_dir.exists():
                all_files.extend(list(search_dir.glob("*.json")))

        # 按时间排序
        sorted_files = sorted(all_files, key=lambda f: f.stat().st_mtime, reverse=True)

        # 按请求ID分组
        grouped = self.group_by_request_id(sorted_files[:count * 3])  # 取更多文件确保有完整的请求

        # 追踪前N个请求
        traces = []
        for request_id in list(grouped.keys())[:count]:
            trace = self.trace_request_pipeline(request_id)
            if 'error' not in trace:
                traces.append(trace)

        return traces

    def identify_pipeline_issues(self, trace: Dict[str, Any]) -> List[str]:
        """识别流水线问题"""
        issues = []

        # 检查错误
        if trace.get('errors'):
            for error in trace['errors']:
                stage = error.get('stage', 'unknown')
                issues.append(f"❌ {stage}阶段发生错误: {error.get('file')}")

        # 检查流水线完整性
        expected_stages = ['llmswitch-workflow', 'compatibility', 'provider']
        actual_stages = [flow['stage'] for flow in trace.get('pipeline_flow', [])]

        for expected in expected_stages:
            if expected not in actual_stages:
                issues.append(f"⚠️  缺少{expected}阶段处理")

        # 检查工具处理
        tool_transformations = [t for t in trace.get('transformations', []) if t['type'] == 'tool_normalization']
        if not tool_transformations:
            # 检查是否有工具请求
            has_tools = any('has_tools' in file.get('data_keys', []) for file in trace.get('files', []))
            if has_tools:
                issues.append("⚠️  检测到工具请求但未发现工具规范化处理")

        return issues

def main():
    parser = argparse.ArgumentParser(description='RouteCodex流水线追踪器')
    parser.add_argument('--count', '-n', type=int, default=5, help='追踪的请求数量')
    parser.add_argument('--request-id', '-r', type=str, help='追踪特定请求ID')
    parser.add_argument('--dir', '-d', type=str, help='自定义日志目录路径')

    args = parser.parse_args()

    tracer = PipelineTracer(args.dir)

    if args.request_id:
        print(f"=== 追踪请求 {args.request_id} ===")
        trace = tracer.trace_request_pipeline(args.request_id)

        if 'error' in trace:
            print(trace['error'])
        else:
            print(f"请求ID: {trace['request_id']}")
            print(f"处理文件数: {len(trace['files'])}")

            print("\n流水线流向:")
            for flow in trace['pipeline_flow']:
                print(f"  {flow['stage']}: {flow['file']}")

            print("\n问题识别:")
            issues = tracer.identify_pipeline_issues(trace)
            if issues:
                for issue in issues:
                    print(f"  {issue}")
            else:
                print("  ✅ 未发现问题")
    else:
        print(f"=== 追踪最新 {args.count} 个请求 ===")
        traces = tracer.trace_latest_requests(args.count)

        for i, trace in enumerate(traces, 1):
            print(f"\n{i}. 请求 {trace['request_id']}")
            print(f"   处理阶段: {len(trace['pipeline_flow'])}")
            print(f"   错误数: {len(trace['errors'])}")
            print(f"   转换数: {len(trace['transformations'])}")

            # 快速问题检查
            issues = tracer.identify_pipeline_issues(trace)
            if issues:
                print("   问题:")
                for issue in issues[:2]:  # 只显示前2个问题
                    print(f"     {issue}")

if __name__ == "__main__":
    main()