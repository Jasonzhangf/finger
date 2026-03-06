#!/usr/bin/env python3
"""
RouteCodex快照解析器
解析和分析流水线执行快照
"""

import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Any, Optional
from collections import defaultdict
import argparse

class SnapshotParser:
    def __init__(self, samples_dir: str = None):
        self.samples_dir = Path(samples_dir or os.path.expanduser("~/.routecodex/codex-samples"))

    def find_snapshots(self, limit: int = 10) -> List[Path]:
        """查找快照文件"""
        all_snapshots = []

        # 搜索所有目录中的快照文件
        for base_dir in ['openai-chat', 'openai-responses']:
            search_dir = self.samples_dir / base_dir
            if search_dir.exists():
                snapshots = list(search_dir.glob("*snapshot*.json"))
                all_snapshots.extend(snapshots)

        # 按时间排序，取最新的
        sorted_snapshots = sorted(all_snapshots, key=lambda f: f.stat().st_mtime, reverse=True)
        return sorted_snapshots[:limit]

    def parse_snapshot(self, snapshot_path: Path) -> Dict[str, Any]:
        """解析单个快照文件"""
        try:
            with open(snapshot_path, 'r') as f:
                data = json.load(f)

            snapshot = {
                'file': str(snapshot_path),
                'timestamp': self.extract_timestamp(snapshot_path.name),
                'request_id': self.extract_request_id(snapshot_path.name),
                'snapshot_type': self.detect_snapshot_type(data),
                'pipeline_state': self.extract_pipeline_state(data),
                'data_flow': self.extract_data_flow(data),
                'errors': self.extract_errors(data),
                'performance': self.extract_performance_data(data)
            }

            return snapshot

        except Exception as e:
            return {
                'file': str(snapshot_path),
                'error': str(e),
                'timestamp': self.extract_timestamp(snapshot_path.name),
                'request_id': self.extract_request_id(snapshot_path.name)
            }

    def detect_snapshot_type(self, data: Dict) -> str:
        """检测快照类型"""
        if not isinstance(data, dict):
            return 'invalid'

        # 检查快照标识
        if 'snapshot' in data:
            return data.get('snapshot', {}).get('type', 'unknown')

        # 基于内容推断类型
        if 'workflow' in data or 'llmswitch' in data:
            return 'workflow'
        elif 'compatibility' in data:
            return 'compatibility'
        elif 'provider' in data:
            return 'provider'
        elif 'request' in data and 'response' in data:
            return 'request_response'
        else:
            return 'generic'

    def extract_pipeline_state(self, data: Dict) -> Dict[str, Any]:
        """提取流水线状态"""
        state = {
            'current_stage': 'unknown',
            'completed_stages': [],
            'pending_stages': [],
            'stage_data': {}
        }

        if not isinstance(data, dict):
            return state

        # 检测当前阶段
        if 'workflow' in data or 'llmswitch' in data:
            state['current_stage'] = 'llmswitch-workflow'
            state['stage_data']['workflow'] = self.extract_workflow_state(data)
        elif 'compatibility' in data:
            state['current_stage'] = 'compatibility'
            state['stage_data']['compatibility'] = self.extract_compatibility_state(data)
        elif 'provider' in data:
            state['current_stage'] = 'provider'
            state['stage_data']['provider'] = self.extract_provider_state(data)

        # 检测完成的阶段
        completed_indicators = {
            'llmswitch-workflow': ['workflow_completed', 'llmswitch_done'],
            'compatibility': ['compatibility_done', 'field_mapping_completed'],
            'provider': ['provider_done', 'http_sent']
        }

        for stage, indicators in completed_indicators.items():
            for indicator in indicators:
                if indicator in str(data):
                    state['completed_stages'].append(stage)
                    break

        return state

    def extract_workflow_state(self, data: Dict) -> Dict[str, Any]:
        """提取工作流状态"""
        workflow_state = {
            'tools_processed': False,
            'streaming_active': False,
            'transformations_applied': []
        }

        # 检查工具处理
        if 'tools' in data or 'tool_calls' in str(data):
            workflow_state['tools_processed'] = True

        # 检查流式处理
        if 'stream' in data and data['stream']:
            workflow_state['streaming_active'] = True

        # 检查转换
        if 'transformations' in data:
            workflow_state['transformations_applied'] = data['transformations']

        return workflow_state

    def extract_compatibility_state(self, data: Dict) -> Dict[str, Any]:
        """提取兼容性处理状态"""
        compatibility_state = {
            'field_mapping_applied': False,
            'config_loaded': False,
            'errors_processed': False
        }

        # 检查字段映射
        if 'field_mapping' in data or 'mapping' in str(data):
            compatibility_state['field_mapping_applied'] = True

        # 检查配置
        if 'config' in data:
            compatibility_state['config_loaded'] = True

        # 检查错误处理
        if 'error_handling' in data or 'error_compat' in str(data):
            compatibility_state['errors_processed'] = True

        return compatibility_state

    def extract_provider_state(self, data: Dict) -> Dict[str, Any]:
        """提取Provider状态"""
        provider_state = {
            'http_sent': False,
            'model_replaced': False,
            'auth_applied': False,
            'response_received': False
        }

        # 检查HTTP请求
        if 'http' in str(data).lower() or 'request' in data:
            provider_state['http_sent'] = True

        # 检查模型替换
        if 'model_mapping' in data or 'model_replace' in str(data):
            provider_state['model_replaced'] = True

        # 检查认证
        if 'auth' in str(data).lower() or 'api_key' in str(data):
            provider_state['auth_applied'] = True

        # 检查响应
        if 'response' in data:
            provider_state['response_received'] = True

        return provider_state

    def extract_data_flow(self, data: Dict) -> Dict[str, Any]:
        """提取数据流信息"""
        flow = {
            'input_size': 0,
            'output_size': 0,
            'transformations': [],
            'field_changes': []
        }

        if not isinstance(data, dict):
            return flow

        # 计算数据大小
        data_str = json.dumps(data, ensure_ascii=False)
        flow['input_size'] = len(data_str)

        # 检测转换
        if 'transformations' in data:
            flow['transformations'] = data['transformations']

        # 检测字段变化
        if 'field_changes' in data:
            flow['field_changes'] = data['field_changes']

        return flow

    def extract_errors(self, data: Dict) -> List[Dict[str, Any]]:
        """提取错误信息"""
        errors = []

        if not isinstance(data, dict):
            return errors

        # 检查直接错误
        for error_field in ['error', 'errors', 'exception']:
            if error_field in data and data[error_field]:
                errors.append({
                    'type': error_field,
                    'details': data[error_field],
                    'stage': 'snapshot'
                })

        # 检查嵌套错误
        for key, value in data.items():
            if isinstance(value, dict):
                nested_errors = self.extract_errors(value)
                for error in nested_errors:
                    error['stage'] = key
                    errors.append(error)

        return errors

    def extract_performance_data(self, data: Dict) -> Dict[str, Any]:
        """提取性能数据"""
        performance = {
            'duration': None,
            'memory_usage': None,
            'processing_time': {}
        }

        if not isinstance(data, dict):
            return performance

        # 检查时间数据
        for time_field in ['duration', 'processing_time', 'elapsed', 'time']:
            if time_field in data:
                performance['duration'] = data[time_field]
                break

        # 检查内存使用
        for memory_field in ['memory', 'memory_usage', 'ram']:
            if memory_field in data:
                performance['memory_usage'] = data[memory_field]
                break

        # 检查各阶段处理时间
        if 'stages' in data and isinstance(data['stages'], dict):
            for stage, stage_data in data['stages'].items():
                if isinstance(stage_data, dict) and 'duration' in stage_data:
                    performance['processing_time'][stage] = stage_data['duration']

        return performance

    def extract_timestamp(self, filename: str) -> Optional[int]:
        """提取时间戳"""
        try:
            parts = filename.split('_')
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1])
        except:
            pass
        return None

    def extract_request_id(self, filename: str) -> Optional[str]:
        """提取请求ID"""
        try:
            parts = filename.split('_')
            if len(parts) >= 3:
                return parts[2]
        except:
            pass
        return None

    def analyze_snapshot_sequence(self, request_id: str) -> Dict[str, Any]:
        """分析特定请求的快照序列"""
        # 查找所有相关快照
        all_snapshots = []
        for base_dir in ['openai-chat', 'openai-responses']:
            search_dir = self.samples_dir / base_dir
            if search_dir.exists():
                pattern = f"*{request_id}*snapshot*.json"
                all_snapshots.extend(list(search_dir.glob(pattern)))

        # 按时间排序
        sorted_snapshots = sorted(all_snapshots, key=lambda f: f.stat().st_mtime)

        sequence = {
            'request_id': request_id,
            'snapshots': [],
            'pipeline_progression': [],
            'total_snapshots': len(sorted_snapshots)
        }

        for snapshot_path in sorted_snapshots:
            snapshot = self.parse_snapshot(snapshot_path)
            sequence['snapshots'].append(snapshot)

            # 分析流水线进展
            if 'pipeline_state' in snapshot:
                state = snapshot['pipeline_state']
                sequence['pipeline_progression'].append({
                    'timestamp': snapshot.get('timestamp'),
                    'current_stage': state.get('current_stage'),
                    'completed_stages': state.get('completed_stages', [])
                })

        return sequence

    def compare_snapshots(self, snapshot1: Dict, snapshot2: Dict) -> Dict[str, Any]:
        """比较两个快照的差异"""
        comparison = {
            'snapshot1_file': snapshot1.get('file'),
            'snapshot2_file': snapshot2.get('file'),
            'stage_changes': [],
            'data_changes': [],
            'error_changes': [],
            'performance_changes': {}
        }

        # 比较流水线阶段
        state1 = snapshot1.get('pipeline_state', {})
        state2 = snapshot2.get('pipeline_state', {})

        if state1.get('current_stage') != state2.get('current_stage'):
            comparison['stage_changes'].append({
                'from': state1.get('current_stage'),
                'to': state2.get('current_stage')
            })

        # 比较完成阶段
        completed1 = set(state1.get('completed_stages', []))
        completed2 = set(state2.get('completed_stages', []))
        new_completed = completed2 - completed1
        if new_completed:
            comparison['stage_changes'].append({
                'new_completed': list(new_completed)
            })

        # 比较错误
        errors1 = snapshot1.get('errors', [])
        errors2 = snapshot2.get('errors', [])
        if len(errors1) != len(errors2):
            comparison['error_changes'].append({
                'from_count': len(errors1),
                'to_count': len(errors2)
            })

        # 比较性能
        perf1 = snapshot1.get('performance', {})
        perf2 = snapshot2.get('performance', {})
        if perf1.get('duration') and perf2.get('duration'):
            duration_change = perf2['duration'] - perf1['duration']
            comparison['performance_changes']['duration_change'] = duration_change

        return comparison

def main():
    parser = argparse.ArgumentParser(description='RouteCodex快照解析器')
    parser.add_argument('--limit', '-n', type=int, default=10, help='解析的快照数量')
    parser.add_argument('--request-id', '-r', type=str, help='分析特定请求的快照序列')
    parser.add_argument('--compare', '-c', action='store_true', help='比较快照差异')
    parser.add_argument('--dir', '-d', type=str, help='自定义日志目录路径')

    args = parser.parse_args()

    parser = SnapshotParser(args.dir)

    if args.request_id:
        print(f"=== 分析请求 {args.request_id} 的快照序列 ===")
        sequence = parser.analyze_snapshot_sequence(args.request_id)

        print(f"快照总数: {sequence['total_snapshots']}")
        print("\n流水线进展:")
        for i, progression in enumerate(sequence['pipeline_progression'], 1):
            stage = progression['current_stage']
            completed = ', '.join(progression['completed_stages'])
            print(f"  {i}. 阶段: {stage}, 已完成: [{completed}]")

    elif args.compare:
        print("=== 快照比较 ===")
        snapshots = parser.find_snapshots(2)
        if len(snapshots) >= 2:
            snapshot1 = parser.parse_snapshot(snapshots[0])
            snapshot2 = parser.parse_snapshot(snapshots[1])

            comparison = parser.compare_snapshots(snapshot1, snapshot2)

            print(f"比较文件:")
            print(f"  文件1: {comparison['snapshot1_file']}")
            print(f"  文件2: {comparison['snapshot2_file']}")

            if comparison['stage_changes']:
                print("\n阶段变化:")
                for change in comparison['stage_changes']:
                    print(f"  {change}")

            if comparison['error_changes']:
                print("\n错误变化:")
                for change in comparison['error_changes']:
                    print(f"  {change}")

            if comparison['performance_changes']:
                print("\n性能变化:")
                for key, value in comparison['performance_changes'].items():
                    print(f"  {key}: {value}")
        else:
            print("需要至少2个快照文件进行比较")

    else:
        print(f"=== 解析最新 {args.limit} 个快照 ===")
        snapshots = parser.find_snapshots(args.limit)

        for i, snapshot_path in enumerate(snapshots, 1):
            snapshot = parser.parse_snapshot(snapshot_path)

            print(f"\n{i}. 快照: {snapshot_path.name}")
            print(f"   类型: {snapshot.get('snapshot_type', 'unknown')}")
            print(f"   请求ID: {snapshot.get('request_id', 'unknown')}")

            if 'pipeline_state' in snapshot:
                state = snapshot['pipeline_state']
                current_stage = state.get('current_stage', 'unknown')
                completed = state.get('completed_stages', [])
                print(f"   当前阶段: {current_stage}")
                print(f"   已完成阶段: {', '.join(completed) if completed else '无'}")

            if 'errors' in snapshot and snapshot['errors']:
                print(f"   错误数: {len(snapshot['errors'])}")

            if 'performance' in snapshot and snapshot['performance'].get('duration'):
                print(f"   处理时间: {snapshot['performance']['duration']}ms")

if __name__ == "__main__":
    main()