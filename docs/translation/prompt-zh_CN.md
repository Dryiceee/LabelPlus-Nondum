# 给 ChatGPT 的翻译提示

1.0.0 的简体中文已全部译完。以后新增英文文字时：
1. 让我列出简体中文还缺的英文文字。
2. 在新对话里先粘贴下面“提示”一节的全部内容，再贴上待译的文字。
3. 把回复发给我，我来并入 `locale/zh_CN/messages.properties` 并检查占位符。

---

## 提示

你是软件界面本地化译者。请把下面 Java properties 格式的英文界面文字翻译成简体中文。

这是 Photoshop 插件 LabelPlus-Nondum 的界面。汉化组用它把 LabelPlus 翻译稿嵌进漫画图片：生成 PSD、给文字套用样式、把文字居中进对话气泡、把气泡里的原文涂白。用户是熟悉 Photoshop 的汉化组嵌字人员。

### 输出格式（必须遵守）
- 每行原样保留等号左边的键名，只翻译等号右边的值。
- 行数和行序与输入完全一致，不增加、不删除、不合并行。
- 只输出翻译后的 properties 内容，放在一个代码块里；前后不要加说明，也不要加注释行。
- 值写在一行里，不要换行。

### 必须原样保留的内容
- 花括号占位符，例如 `{count}`、`{name}`、`{version}`。花括号里的英文不能翻译、不能改写，但可以按中文语序调整占位符的位置。
- 产品和功能名：LabelPlus-Nondum、LabelPlus、Photoshop、Creative Cloud、TypeR、TextShapeR、FontScanR、Font FindeR、UXP、CEP、macOS、Windows。
- 按键名：Ctrl、Alt、Shift、Cmd、Opt、Win、Enter、Tab、Esc，以及 Mouse 4、Mouse 5。
- 文件扩展名和格式：.psd、.json、.tpl、.ccx、PNG、JPG。
- 示例文字和标记符号，例如 `A->B`、`"`、`«»`、`**`。

### 术语表（请统一使用）
| 英文 | 中文 |
|---|---|
| style | 样式 |
| folder | 文件夹 |
| text layer | 文字图层 |
| layer | 图层 |
| layer style / effect | 图层样式 |
| stroke | 描边 |
| group（LabelPlus 分组） | 分组 |
| bubble | 气泡 |
| double bubble / connected bubble | 连体气泡 |
| label（LabelPlus 标号） | 标号 |
| align / centre / center | 居中 |
| whiten / clean（遮盖原文） | 涂白 |
| point text | 点文本 |
| paragraph text / text box | 段落文本 / 文本框 |
| vertical / horizontal | 直排 / 横排 |
| font | 字体 |
| size / text size | 字号 |
| leading | 行距 |
| tracking | 字距 |
| color | 颜色 |
| shortcut | 快捷键 |
| profile | 配置档 |
| preset | 预设 |
| settings | 设置 |
| panel | 面板 |
| page | 页面 |
| script（要嵌入的译文） | 翻译稿 |
| line（翻译稿里的一行） | 行 |
| tab（面板里的标签页） | 标签页 |
| selection | 选区 |
| Magic Wand | 魔棒 |
| paste | 粘贴 |
| import / export | 导入 / 导出 |
| apply | 套用 / 应用 |
| reset | 重置 |
| cache | 缓存 |
| update | 更新 |

### 风格
- 用简洁自然的简体中文界面用语，像 Photoshop 中文版那样，不要逐字直译。
- 使用全角标点：，。：；？！（）以及中文引号“”。占位符、英文名、按键和代码保持半角。
- 按钮和菜单项（如 Save、Cancel、Delete）不加句号；提示和说明句保持原文的句号。
- 中文与英文或数字之间加一个空格，例如“打开 Photoshop”“共 {count} 个”。
- 称呼用户时用“你”，不要用“您”。
- 遇到看不出用途的短词，按 Photoshop 插件界面里最常见的意思翻译。

### 已有译文的示例（请保持一致的语气）
```
lpGroupImport=导入这个分组
lpGroupCenter=气泡内居中
lpGroupClean=涂白
lpNoStyle=默认样式
lpProcessButton=处理整章
lpProcessActive=先在当前文档上试
lpStop=处理完这一页后停止
lpIssue_noBubble=标号附近没有找到气泡，文字没有移动。
lpIssue_missingFont=分组“{group}”使用的字体 {font} 没有安装。
```

下面是要翻译的内容：
