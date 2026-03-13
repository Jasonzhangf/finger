# CI Fix: pnpm and @anthropic-ai/sdk Peer Dependency (2026-03-13)

## 问题诊断

GitHub Actions CI 失败，错误信息：

```
npm error ERESOLVE unable to resolve dependency tree
npm error While resolving: fingerdaemon@0.1.0
npm error Found: @anthropic-ai/sdk@0.36.3
npm error node_modules/@anthropic-ai/sdk
npm error
npm error Could not resolve dependency:
npm error peer @anthropic-ai/sdk@"^0.40.1" from mem0ai@2.3.0
```

## 根本原因

1. **依赖冲突**: `package.json` 中 `@anthropic-ai/sdk` 版本为 `^0.36.0`
2. **Peer 依赖**: `mem0ai@2.3.0` 要求 `@anthropic-ai/sdk@^0.40.1`
3. **Lock 文件缺失**: CI 中使用 npm ci 但项目使用 pnpm-lock.json

## 修复方案

### 1. 升级 @anthropic-ai/sdk

**文件**: `package.json`

```diff
-    "@anthropic-ai/sdk": "^0.36.0",
+    "@anthropic-ai/sdk": "^0.40.1",
```

### 2. 切换 CI 到 pnpm

**文件**: `.github/workflows/ci.yml`

```diff
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
-          cache: 'npm'
+          cache: 'pnpm'

+      - name: Install pnpm
+        run: npm install -g pnpm

      - name: Install dependencies
-        run: npm ci
+        run: pnpm install

      - name: Build
-        run: npm run build
+        run: pnpm run build

      - name: Lint
-        run: npm run lint
+        run: pnpm run lint

      - name: Test
-        run: npm run test -- --run
+        run: pnpm run test -- --run
```

## 验证结果

### 本地验证

```bash
# 使用 pnpm 重新安装
pnpm install

# 构建成功
pnpm run build:backend
```

### CI 验证

- Commit: `834e6e9` - ci: Switch from npm to pnpm in GitHub Actions
- CI run: 等待验证

## 关键要点

1. **Peer 依赖管理**: 升级依赖时必须检查 peer 依赖要求
2. **包管理器一致性**: CI 必须使用与本地相同的包管理器（npm vs pnpm）
3. **Lock 文件匹配**: `cache: 'pnpm'` 需要 `pnpm-lock.json` 存在
4. **pnpm 优势**: 更快的安装速度，更严格的依赖管理

## 相关 Commits

1. `33fce73` - feat: Migrate /resume to agent layer, add session tools, implement system:restart
2. `1f8f0ee` - fix: Upgrade @anthropic-ai/sdk to 0.40.1 to resolve mem0ai peer dependency
3. `834e6e9` - ci: Switch from npm to pnpm in GitHub Actions

## 相关文件

- `package.json` - 依赖版本
- `pnpm-lock.json` - pnpm lock file
- `.github/workflows/ci.yml` - CI 配置

Tags: ci, pnpm, peer-dependency, anthropic-sdk, mem0ai, github-actions
