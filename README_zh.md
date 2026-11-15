# mol4agent

[English](README.md) | 中文

让 agent harness 里的分子结构文件从「一大段纯文本」变成「可预览、可被 agent 直接操作的 3D 页面」。

- **人工打开**：在 harness 的文件预览器里点开 `.pdb` / `.cif` / `.sdf` / `.mol2` / `.xyz` / `.gro`，右侧直接显示 Mol* 官方 3D 界面；「打开方式」里仍可切回纯文本/代码。
- **agent 操作**：LLM 通过 `mol_*` 工具改表示、配色、高亮残基/配体、聚焦镜头、测量、截图，人只看着页面变化。
- **agent 主动打开**：指定文件后页面自动打开该结构。
- **跨 harness**：渲染与命令协议在 `@gcszhn/mol4agent-core`，每个 harness 一个薄适配包。

## 架构

```mermaid
flowchart TB
  subgraph Harnesses["Agent harnesses"]
    DSH["@gcszhn/mol4agent-deepseekharness<br/>DSH adapter"]
    OA["future ChatGPT/Codex adapter"]
  end

  subgraph Core["@gcszhn/mol4agent-core"]
    Proto["protocol + formats + selectors"]
    Viewer["Mol* official UI viewer"]
    Parse["byte-oriented summarizers"]
  end

  DSH -->|"path → bytes + MolFormat"| Proto
  OA -->|"raw bytes + MolFormat"| Proto
  Proto --> Viewer
  Proto --> Parse
  Viewer --> Capture["PNG capture"]
```

**核心边界（最重要的一条）**：`core` 只接收字节 + 显式 format：

```ts
viewer.load({ data: bytes, format: 'pdb', label: '1crn.pdb' })
```

- DSH 从预览接口拿到 path，由 DSH 适配包用 DSH 自己的 API 读成字节；
- ChatGPT/Codex 直接给 raw data；
- `.pdb → pdb` 的路径/扩展名判断、鉴权、文件系统、session、UI 全部在适配包；
- core 不含任何路径识别/判断逻辑，也不引用任何 harness 包。

## 包

| 包 | 作用 | 状态 |
|---|---|---|
| [`@gcszhn/mol4agent-core`](packages/core) | 与 harness 无关的 Mol* 渲染引擎、命令协议、选择器、字节摘要、PNG 截图 | 已实现；用真实 1CRN/1ATP/aspirin 验证 |
| [`@gcszhn/mol4agent-deepseekharness`](packages/deepseek-harness) | DSH 适配：右侧文档预览、session projection、`mol_*` 工具、截图回传 | 已实现并安装到 Desktop profile |
| `@gcszhn/mol4agent-chatgpt` | 后续的 ChatGPT/Codex 适配 | 未开始 |

## 快速开始（DSH Desktop）

### 安装 / 重装

在本仓库根目录执行：

```sh
cd /path/to/mol4agent
pnpm build
dsh plugin --profile desktop add link:"$PWD/packages/deepseek-harness"
```

`dsh plugin` 会把参数转发给 `~/.dsh/profiles/<profile>` 下的 pnpm。还需要把
`@gcszhn/mol4agent-deepseekharness` 放进该 profile `package.json` 的
`dsh.profile.bundles`（DSH Plugin manager 安装/启用时会自动处理）；安装或更新
Host bundle 后重启 DSH。

npm 形式（0.1.0，发布后）：

```sh
dsh plugin --profile desktop add @gcszhn/mol4agent-deepseekharness@0.1.0
```

卸载：`dsh plugin --profile desktop remove @gcszhn/mol4agent-deepseekharness`，
并从 `dsh.profile.bundles` 中移除。

当前 `desktop` profile 已安装并启用：

1. 在文件树里打开 `fixtures/1crn.pdb`（或 `fixtures/1atp.pdb`、`fixtures/aspirin.sdf`、`fixtures/1crn.cif`）。
   - 默认显示「结构预览」；预览器工具栏的「打开方式」可切回纯文本/代码。
2. 让 agent 执行：
   > 打开 fixtures/1atp.pdb，用卡通表示、chain-id 配色，高亮配体 ATP 并聚焦，然后截图给我看。
3. 截图保存到工作区 `.mol4agent/captures/`；如果当前模型声明了图片输入，也会作为图片返回。

**生效方式**：Host 侧代码（`lib/host.js`）变更需要重启 DSH；client 侧代码（`lib/client.js`）变更刷新页面即可。

## 开发

```sh
pnpm install
pnpm typecheck   # 先构建 core，再对所有包做 typecheck
pnpm build       # core -> lib JS/d.ts，然后 DSH host/client
```

`build` 产出：

- `lib/host.js`（DSH Host，ESM，`@deepseek-ai/*` external）
- `lib/client.js`（DSH lazy-CJS browser bundle，含 Mol* 官方 UI，约 3.65 MiB；单 bundle，无懒加载 chunk）

## 文档

- [Core API](packages/core/README_zh.md)：`createMolViewer`、`StructureData`、命令、选择器、摘要、截图、React 绑定。
- [DSH agent 接口](packages/deepseek-harness/README_zh.md)：`mol_*` 工具、session projection、文档预览、截图回传。
- [总体架构](docs/architecture_zh.md)（[English](docs/architecture.md)）：产品目标、分层、跨 harness 契约和高层流程；具体实现见各包文档。
- [DSH 适配细节](packages/deepseek-harness/docs/DETAIL.md)：工具行为、选择器示例、限制。

English: [README.md](README.md), [core](packages/core/README.md),
[DSH adapter](packages/deepseek-harness/README.md).
