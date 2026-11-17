# @gcszhn/mol4agent-opencode

[mol4agent](../../README_zh.md) 的 OpenCode 2 适配器：在 harness 内的侧边栏里
用官方 Mol* 3D 视图预览分子结构，agent 通过 `mol_*` 工具直接操作。

- **harness 内预览**：`mol_open`（agent）、**Ctrl+P 文件搜索**（即 `/open` 指令，
  LinkHandler）、以及「Open molecular structure」选文件命令（人类）在侧边栏的
  官方 Mol* UI 里渲染结构，无需离开 harness、无需外部应用。
- **agent 操作同一页面**：`mol_style` / `mol_select` / `mol_focus` / `mol_measure`
  修改打开的页面；`mol_info` / `mol_interface` 无需打开 viewer 即可摘要。
- **数据库抓取**：`mol_fetch` 从 RCSB PDB（PDB/mmCIF/BinaryCIF）、AlphaFold DB、
  PubChem 或 ChEMBL 下载结构并保存在会话所属 server 上，随后可直接 `mol_open`。
- **截图**：`mol_capture` 把视口渲染成 PNG 保存到 `.mol4agent/captures/`。
- **标签保持状态**：每个结构一个 viewer 标签；切换标签会保留相机、样式和选择。
  viewer 也会在切换会话标签页后保留，切回同一会话时恢复之前的状态；关闭结构标签
  会销毁对应 viewer（已关闭会话的 viewer 在窗口卸载时清理）。

> **温馨提示**：每个打开的结构都会保留一个常驻的 Mol* viewer（占用 WebGL
> context 和内存），切换标签/会话也不会释放。适配器最多保留 12 个常驻 viewer，
> 超出时会释放最久未使用的隐藏 viewer。请只打开需要的结构，用完记得关闭结构标签。

- **与 DSH/ChatGPT 语义一致**：本适配器把相同的 `MolFormat`、selector、命令
  与截图语义传给 `@gcszhn/mol4agent-core`。
- **格式**：`.pdb`、`.ent`、`.pdbqt`、`.pqr`、`.cif`、`.mmcif`、`.mcif`、`.bcif`、
  `.mol`、`.sdf`、`.sd`、`.mol2`、`.xyz`、`.gro`，以及 `.gz` 变体（server 端先解压
  再交给 core）。

![OpenCode 桌面端：agent 在左侧改代码，右侧侧栏用官方 Mol* UI 渲染 aspirin.sdf](docs/opencode-viewer.jpg)

## 打开结构（OpenCode）

- **agent**：`mol_open`（先 `mol_info` 选链/残基）。
- **人类**：
  - **Ctrl+P 文件检索**（即 `/open` 指令）→ 输入文件名 → 选中 `.pdb`/`.cif`/... 条目，会通过 `LinkHandler` 在 Mol* 面板里打开。
  - **Open molecular structure** 命令（系统选文件）。
- **没有 `/mol_open` 斜杠命令**：它的名字会和 agent 工具 `mol_open` 冲突；
  Ctrl+P（即 `/open`）与选文件命令已覆盖人类打开路径。
- **不能从内置文件树打开**：在文件树里点击 `.pdb` 会打开纯文本编辑器。OpenCode 不会把文件树点击路由给插件（注册 `"text"` kind 的 `FileViewer` 会被忽略），所以请用 **Ctrl+P**（`/open`）而不是点文件树。

## 架构

本包是一个包含三部分的 OpenCode 插件：

- **server**（`exports["."]`，`src/server.ts`）：注册 `mol_*` 工具与 `mol4agent`
  RPC。只有这里能看到路径、读取字节、保存场景日志。
- **GUI**（`exports["./gui-experimental"]`，`src/gui/`）：侧边栏 `Panel`，每个
  打开的结构一个 Mol* viewer 标签；另有启动器、选文件命令，以及 `LinkHandler`
  （Ctrl+P 文件搜索，即 `/open`，与 `.pdb` 链接可打开结构）。通过 RPC 跟随场景，
  并渲染/回传截图。RPC 指向**会话所属 server**（`session.server.client`）：窗口的
  `ctx.client` 始终是内置本地 server。
- **RPC**（`exports["./rpc"]`，`src/rpc.ts`）：类型化的 `mol4agent` 契约。

core 只接收 `{ data, format, label }` 加 JSON 命令；路径、后缀识别、IO、session
与 UI 全部留在本适配器内。

## 兼容性

需要 **OpenCode 2.2.0 或更新**——`@opencode/plugin/gui` 的窗口 API（`./gui`、
`./gui/file`、`./gui/vite`、panel/RPC 注册）是 `@opencode/plugin` 2.2.0 才引入的。
构建和验证基于 **2.3.0**；本包声明 `@opencode/plugin` peer 依赖 `>=2.2.0 <3.0.0`。

OpenCode v1 无法运行本适配器：v1 是终端 UI，没有 GUI 插件层、没有自定义 RPC、
也没有 DOM/WebGL 供 Mol* 使用。它的 server/TUI 插件无法渲染可交互 3D 页面或返回
渲染好的截图，因此只能移植纯文本的 `mol_info` / `mol_interface` / `mol_fetch` 工具。

### 远程 server 与网页端

OpenCode 2.3 的窗口插件宿主只会从桌面端**内置 server**加载 GUI bundle，并把 GUI
的 `ctx.client` 绑定到该内置 server，即使当前会话属于远程（SSH）server。因此本适配
器把 GUI 当作「会话所属 server」的瘦客户端：

- GUI 的每次 RPC 调用都走 `session.server.client`，并带上会话服务端的 location。
  `mol_open`、样式、聚焦、测量与截图都在会话所属 server 上执行；路径也由该 server
  按会话 workspace 解析。GUI 绝不用客户端操作系统的规则判断/改写路径。
- 在**远程桌面会话**中查看结构时，插件需要同时安装在桌面机（全局配置：提供 GUI 与
  选文件）和远程 server（提供 `mol_*` 工具）。只装在远程时 agent 能看到工具，但桌面
  端没有面板：桌面端不会从非内置 server 加载 GUI bundle。
- 「Open molecular structure」系统选文件读取的是**桌面机**上的文件，因此远程会话下
  会禁用。请改用 Ctrl+P 文件检索、点击对话中的 `.pdb`/`.cif` 路径，或让 agent 执行
  `mol_open`；这些方式都会把路径交给会话所属 server 解析。

### 当前局限：网页端只有工具，没有 viewer

Mol* 面板依赖**桌面端的本地 GUI 插件宿主**。`opencode serve` 提供的 OpenCode 2.3
网页端没有 plugin-GUI bridge，不会挂载 `./gui-experimental`：没有侧栏、没有 viewer，
也没有截图目标。server 部分仍然可用——`mol_open` 会在会话所属 server 上记录场景、
`mol_*` 工具照常执行——但由于没有 viewer 渲染，`mol_capture` 会超时。查看结构请使用
桌面端（本地，或连接远程 server）；浏览器会话只能使用工具。

## 工具

| 工具 | 行为 |
|---|---|
| `mol_info` | 摘要链、残基、原子、配体；不打开 viewer |
| `mol_interface` | 寻找两组链之间的界面残基（PDB 类 ATOM 文件） |
| `mol_fetch` | 下载数据库条目（`entry_id`、`target_path`、`source_db?`）并保存到会话所属 server |
| `mol_open` | 在侧边栏打开结构并设为活动场景 |
| `mol_style` | 修改表示/颜色；带 `target` 时叠加式着色某个选区。`colorParams.value` 只对 `uniform` 生效（CSS 名称、十六进制或整数） |
| `mol_select` | 选择/高亮（可同时聚焦）某个选区 |
| `mol_focus` | 聚焦某个选区或整个结构 |
| `mol_measure` | 添加距离(2)/角度(3)/二面角(4)测量 |
| `mol_capture` | 把视口渲染成 PNG 保存到 `.mol4agent/captures/` |

selector 与其他适配器使用相同的 JSON 形状，见 [README.md](README.md)。

### 颜色

`color` 选择 Mol* 的颜色**主题**（`chain-id`、`element-symbol` 等）；
`colorParams.value` 只对 `uniform` 主题生效。单独写 `color: "uniform"` 只是
主题名，不是具体颜色。

`colorParams.value` 接受 CSS 颜色名（`"red"`、`"lightgrey"`）、十六进制
（`"#f00"`、`"#ff000080"`）、`0x` 或裸十六进制（`"0xB0B0B0"`）、
`rgb()`/`rgba()`，或 24 位整数（`16711680`）。alpha 会被接受但忽略。无法解析
的值会在场景更新前被拒绝，`mol_style` 会回显解析后的十六进制颜色，例如
`Applied cartoon / uniform #ff0000 to polymer.`。

常用值：红 `0xff0000`、蓝 `0x0000ff`、白 `0xffffff`、灰 `0x808080`、
浅灰 `0xd3d3d3`。

### 数据库来源

`mol_fetch` 接收 `entry_id`、`target_path`，以及可选的 `source_db`（默认
`rcsb-pdb`）。`target_path` 与其他路径参数走相同的 server 端规则：绝对路径，或
相对会话 workspace。目标为目录（或以 `/` 结尾）时自动追加来源文件名；无后缀的
路径会补上来源后缀。

| `source_db` | `entry_id` | 保存格式 |
|---|---|---|
| `rcsb-pdb`（默认） | 4 字符 PDB id，例如 `1crn` | `.pdb` |
| `rcsb-cif` | 4 字符 PDB id，例如 `1crn` | `.cif`（mmCIF） |
| `rcsb-bcif` | 4 字符 PDB id，例如 `1crn` | `.bcif`（BinaryCIF） |
| `alphafold` | UniProt accession，例如 `P00533` | `.pdb` |
| `pubchem` | CID（`2244`）或化合物名（`aspirin`） | `.sdf`（3D） |
| `chembl` | ChEMBL id（`CHEMBL25`）或纯数字（`25`） | `.sdf` |

条目 id 的规范化和校验在 core（`@gcszhn/mol4agent-core/sources`）；OpenCode
server 负责 HTTPS 下载，上限 64 MiB、30 秒超时，并先写临时文件再原子替换，失败
的抓取不会留下半个结构。目标文件已存在会被覆盖。AlphaFold 的文件名带版本号，
所以 server 会先通过 AlphaFold JSON API 解析 `0.pdbUrl`，再下载实际文件。

```json
{ "entry_id": "1crn", "target_path": "fixtures/1crn.pdb" }
{ "entry_id": "aspirin", "source_db": "pubchem", "target_path": "fixtures/" }
{ "entry_id": "P00533", "source_db": "alphafold", "target_path": "egfr.pdb" }
```

## 安装

### 从 npm 安装

```sh
opencode plugin add @gcszhn/mol4agent-opencode
```

`plugin add` 会安装包并写入**全局** `opencode.json(c)`，桌面端会在每个窗口加载
其 GUI 部分。可用 `@0.2.0` 固定版本；用 `opencode plugin list` 确认（桌面端
**Settings > Extensions > Plugins** 也可查看）。当 `packages/opencode/package.json`
的版本在 `main` 上变化时会自动发布；未发布的改动请先用下面的本地源码方式。

### 从本地源码安装

```sh
pnpm install
pnpm --filter @gcszhn/mol4agent-core build
pnpm --filter @gcszhn/mol4agent-opencode build
```

`opencode plugin add` 只接受 npm/Git spec；本地源码请在全局配置里直接写目录：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/mol4agent/packages/opencode"
  ]
}
```

server 部分按当前 location 加载；GUI 部分由桌面端从其内置 server 加载（远程安装见
[远程 server 与网页端](#远程-server-与网页端)）。GUI 重新构建后无需重启即可
热更新（`pnpm --filter @gcszhn/mol4agent-opencode build`）；server 改动需要 `/reload`。

## 开发

```sh
pnpm --filter @gcszhn/mol4agent-opencode typecheck
pnpm --filter @gcszhn/mol4agent-opencode test
pnpm --filter @gcszhn/mol4agent-opencode build
```

`test` 会先构建 core，再运行 Node 测试；`build` 产出：

- `dist/index.js` — server 部分（ESM；core 打包，`@opencode/*`/`node:*` external）。
- `dist/gui.cjs` — GUI 部分（单 CommonJS 文件；core + Mol* + React 打包）。
- `dist/rpc.js` — RPC 契约。

## 限制

- OpenCode 的工具结果没有内联图片内容类型，因此 `mol_capture` 返回保存路径
  （加一个 `file` 引用），而不是把 PNG 附加到模型上下文。
- **浏览器会话只有工具。** viewer 面板依赖桌面端的本地 GUI 插件宿主；`opencode
  serve` 网页端没有 plugin-GUI bridge，`mol_open` 只会记录场景，不会挂载 viewer，
  `mol_capture` 会超时。Mol* 面板请使用桌面端。
- **内置文件树不能打开结构**：在文件树里点 `.pdb` 会打开文本编辑器。请用
  **Ctrl+P 文件检索**（即 `/open`）或选文件命令。注册 `"text"` kind 的
  `FileViewer` 会被宿主忽略（它只渲染 file view 自己不渲染的 kind）。
- Scene 工具默认作用于**工具调用所在 session** 上次 `mol_open` 的结构；传 `tab`
  （`mol_open` 返回的路径）可指定某个已打开结构。场景按 session 分桶；面板跟随
  当前路由的 session（切换标签页时会自动刷新）。
- `mol_capture` 需要目标 viewer 标签挂载：它会先激活该标签，若 15 秒内仍无法创建
  viewer（例如窄屏时侧栏未打开）则失败。
- GUI 首次挂载时，面板只列出当前 session 已存储的标签；若活动结构的标签不在
  标签栏里，用 **Molecular viewer** 菜单项重新显示。
- `mol_interface` 只解析 PDB 类 ATOM 记录；`mol_info` 尚不能从原始字节摘要 BCIF。
- `mol_fetch` 需要**会话所属 server** 能访问外网 HTTPS——远程 server 会自己在
  远端下载并保存文件，而不是下载到桌面机。下载上限 64 MiB、30 秒超时；失败的
  抓取不会留下半个文件。PubChem 按 3D SDF（`record_type=3d`）请求，没有 3D 构象
  的化合物会返回 HTTP 404。下载内容按未压缩保存，因此 `.gz` 目标会被拒绝。
- 文件上限 64 MiB（含 gzip 解压后）；需要 WebGL 2。每个 session 最多保留 12 个打开的
  结构标签（淘汰最旧的非活动标签）。
