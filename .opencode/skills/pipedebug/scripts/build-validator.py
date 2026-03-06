#!/usr/bin/env python3
"""
RouteCodex构建验证脚本
自动化验证TypeScript编译、类型检查和代码质量
"""

import os
import sys
import subprocess
import json
import time
from pathlib import Path
from typing import Dict, List, Any, Optional
import argparse

class BuildValidator:
    def __init__(self, project_root: str = None):
        self.project_root = Path(project_root or "../../routecodex-worktree/fix")
        self.results = {
            'clean': False,
            'build': False,
            'typecheck': False,
            'lint': False,
            'format': False,
            'errors': [],
            'warnings': [],
            'start_time': time.time(),
            'end_time': None,
            'duration': None
        }

    def run_command(self, command: List[str], cwd: Path = None) -> Dict[str, Any]:
        """运行命令并返回结果"""
        if cwd is None:
            cwd = self.project_root

        try:
            result = subprocess.run(
                command,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=300  # 5分钟超时
            )

            return {
                'success': result.returncode == 0,
                'returncode': result.returncode,
                'stdout': result.stdout,
                'stderr': result.stderr,
                'command': ' '.join(command)
            }

        except subprocess.TimeoutExpired:
            return {
                'success': False,
                'returncode': -1,
                'stdout': '',
                'stderr': 'Command timed out after 300 seconds',
                'command': ' '.join(command)
            }

        except Exception as e:
            return {
                'success': False,
                'returncode': -1,
                'stdout': '',
                'stderr': str(e),
                'command': ' '.join(command)
            }

    def validate_build(self) -> bool:
        """验证构建"""
        print("🔨 执行构建...")

        result = self.run_command(['npm', 'run', 'build'])

        if result['success']:
            print("✅ 构建成功")

            # 检查构建产物
            dist_dir = self.project_root / "dist"
            if dist_dir.exists() and any(dist_dir.iterdir()):
                print(f"✅ 构建产物生成: {dist_dir}")
                self.results['build'] = True
                return True
            else:
                print("❌ 构建产物未生成")
                self.results['errors'].append("Build artifacts not found")
                return False
        else:
            print(f"❌ 构建失败:")
            print(result['stderr'])
            self.results['errors'].append(f"Build failed: {result['stderr']}")
            return False

    def validate_typecheck(self) -> bool:
        """验证类型检查"""
        print("🔍 执行类型检查...")

        # 尝试不同的类型检查命令
        typecheck_commands = [
            ['npm', 'run', 'typecheck'],
            ['npm', 'run', 'type-check'],
            ['npx', 'tsc', '--noEmit']
        ]

        for command in typecheck_commands:
            result = self.run_command(command)
            if result['success']:
                print("✅ 类型检查通过")
                self.results['typecheck'] = True
                return True
            elif "not found" not in result['stderr'].lower():
                # 命令存在但执行失败
                print(f"❌ 类型检查失败:")
                print(result['stderr'])
                self.results['errors'].append(f"Typecheck failed: {result['stderr']}")
                return False

        print("⚠️  未找到类型检查命令，跳过")
        self.results['typecheck'] = True
        return True

    def validate_lint(self) -> bool:
        """验证代码检查"""
        print("🔍 执行代码检查...")

        result = self.run_command(['npm', 'run', 'lint'])

        if result['success']:
            print("✅ 代码检查通过")
            self.results['lint'] = True
            return True
        else:
            # 检查是否有error级别的问题
            stderr = result['stderr']
            if 'error' in stderr.lower():
                print(f"❌ 代码检查发现问题:")
                print(stderr)
                self.results['errors'].append(f"Lint errors found: {stderr}")
                return False
            else:
                print("⚠️  代码检查有警告，但无错误")
                self.results['warnings'].append(f"Lint warnings: {stderr}")
                self.results['lint'] = True
                return True

    def validate_format(self) -> bool:
        """验证代码格式"""
        print("📝 检查代码格式...")

        # 尝试不同的格式检查命令
        format_commands = [
            ['npm', 'run', 'format:check'],
            ['npm', 'run', 'format-check'],
            ['npx', 'prettier', '--check', '.']
        ]

        for command in format_commands:
            result = self.run_command(command)
            if result['success']:
                print("✅ 代码格式正确")
                self.results['format'] = True
                return True
            elif "not found" not in result['stderr'].lower():
                # 命令存在但格式不正确
                print("⚠️  代码格式需要修正")
                self.results['warnings'].append("Code format needs fixing")

                # 尝试自动修复
                fix_result = self.run_command(['npm', 'run', 'format'])
                if fix_result['success']:
                    print("✅ 已自动修复格式")
                    self.results['format'] = True
                    return True
                else:
                    print("❌ 自动格式修复失败")
                    return False

        print("⚠️  未找到格式检查命令，跳过")
        self.results['format'] = True
        return True

    def validate_dependencies(self) -> bool:
        """验证依赖"""
        print("📦 验证依赖...")

        # 检查node_modules
        node_modules = self.project_root / "node_modules"
        if not node_modules.exists():
            print("❌ node_modules不存在，正在安装...")
            result = self.run_command(['npm', 'install'])
            if not result['success']:
                print(f"❌ 依赖安装失败: {result['stderr']}")
                self.results['errors'].append(f"Dependencies install failed: {result['stderr']}")
                return False

        print("✅ 依赖验证完成")
        return True

    def generate_report(self) -> Dict[str, Any]:
        """生成验证报告"""
        self.results['end_time'] = time.time()
        self.results['duration'] = self.results['end_time'] - self.results['start_time']

        success_count = sum(1 for key in ['clean', 'build', 'typecheck', 'lint', 'format']
                           if self.results.get(key, False))

        self.results['overall_success'] = success_count == 5
        self.results['success_rate'] = success_count / 5

        return self.results

    def print_summary(self):
        """打印验证摘要"""
        report = self.generate_report()

        print("\n" + "="*50)
        print("📊 构建验证报告")
        print("="*50)

        print(f"⏱️  总耗时: {report['duration']:.2f}秒")
        print(f"📈 成功率: {report['success_rate']*100:.1f}%")

        print("\n📋 验证结果:")
        checks = {
            'build': '构建编译',
            'typecheck': '类型检查',
            'lint': '代码检查',
            'format': '代码格式'
        }

        for key, name in checks.items():
            status = "✅ 通过" if report.get(key, False) else "❌ 失败"
            print(f"  {name}: {status}")

        if report['errors']:
            print(f"\n❌ 错误 ({len(report['errors'])}):")
            for i, error in enumerate(report['errors'], 1):
                print(f"  {i}. {error}")

        if report['warnings']:
            print(f"\n⚠️  警告 ({len(report['warnings'])}):")
            for i, warning in enumerate(report['warnings'], 1):
                print(f"  {i}. {warning}")

        print("\n" + "="*50)
        if report['overall_success']:
            print("🎉 构建验证全部通过！")
        else:
            print("❌ 构建验证存在问题，请修复后重试")
        print("="*50)

    def run_full_validation(self) -> bool:
        """运行完整验证"""
        print("🚀 开始构建验证...")

        # 验证步骤
        steps = [
            ('依赖验证', self.validate_dependencies),
            ('执行构建', self.validate_build),
            ('类型检查', self.validate_typecheck),
            ('代码检查', self.validate_lint),
            ('格式检查', self.validate_format)
        ]

        for step_name, step_func in steps:
            print(f"\n--- {step_name} ---")
            if not step_func():
                print(f"❌ {step_name}失败，停止验证")
                return False

        return True

def main():
    parser = argparse.ArgumentParser(description='RouteCodex构建验证脚本')
    parser.add_argument('--project-root', '-r', type=str, help='项目根目录路径')
    parser.add_argument('--output', '-o', type=str, help='报告输出文件路径')
    parser.add_argument('--step', '-s', type=str,
                       choices=['clean', 'build', 'typecheck', 'lint', 'format'],
                       help='只执行特定步骤')
    parser.add_argument('--quiet', '-q', action='store_true', help='静默模式')

    args = parser.parse_args()

    validator = BuildValidator(args.project_root)

    if args.step:
        # 执行特定步骤
        step_methods = {
            'build': validator.validate_build,
            'typecheck': validator.validate_typecheck,
            'lint': validator.validate_lint,
            'format': validator.validate_format
        }

        if args.step in step_methods:
            success = step_methods[args.step]()
            if not args.quiet:
                validator.print_summary()
            sys.exit(0 if success else 1)
        else:
            print(f"未知步骤: {args.step}")
            sys.exit(1)
    else:
        # 执行完整验证
        success = validator.run_full_validation()

        if not args.quiet:
            validator.print_summary()

        sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()