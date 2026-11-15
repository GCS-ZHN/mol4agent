/** DSH client locale dictionaries for the molecule preview. @module @gcszhn/mol4agent-deepseekharness/client/locale */
export const NS = 'mol4agent'

export type MolTranslate = (key: string) => string

const en = {
  viewer: 'Structure',
  loading: 'Rendering structure…',
  failed: 'Could not render this structure',
  retry: 'Retry',
  reset: 'Reset view',
  cartoon: 'Cartoon',
  ballStick: 'Ball & stick',
  screenshot: 'Save screenshot',
  openViewer: 'Open structure viewer',
  unsupported: 'No molecular viewer for this file',
  noFile: 'This tab has no readable file path',
}

const zh: typeof en = {
  viewer: '结构预览',
  loading: '正在渲染结构…',
  failed: '无法渲染此结构',
  retry: '重试',
  reset: '重置视角',
  cartoon: '卡通',
  ballStick: '球棍',
  screenshot: '保存截图',
  openViewer: '打开结构预览',
  unsupported: '此文件没有可用的分子查看器',
  noFile: '此标签没有可读的文件路径',
}

export const DICTIONARIES = { en, zh }
