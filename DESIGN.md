---
name: DailyNews
description: 一张克制、清晰、便于先扫读后深读的个人晨间新闻调度单。
colors:
  signal-cobalt: "#0b62d6"
  cool-paper: "#f2f4f3"
  graphite-ink: "#111820"
  steel-marker: "#a8b0b7"
  muted-copy: "#58616a"
  divider: "rgba(17, 24, 32, 0.2)"
  divider-soft: "rgba(17, 24, 32, 0.1)"
typography:
  brand:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(1.9rem, 2.5vw, 2.35rem)"
    fontWeight: 760
    lineHeight: 1
    letterSpacing: "-0.035em"
  display:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(3.5rem, 4.4vw, 4.35rem)"
    fontWeight: 790
    lineHeight: 1.03
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "1.2rem"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(1.12rem, 1.55vw, 1.38rem)"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  ledgerTitle:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(2rem, 3.2vw, 3.2rem)"
    fontWeight: 760
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  storyTitle:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(1.18rem, 1.55vw, 1.5rem)"
    fontWeight: 700
    lineHeight: 1.38
    letterSpacing: "-0.02em"
  radarTitle:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(1.25rem, 2vw, 1.8rem)"
    fontWeight: 720
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.72
    letterSpacing: "normal"
  supporting:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
  term:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 680
    lineHeight: 1.5
    letterSpacing: "normal"
  control:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 680
    lineHeight: 1.4
    letterSpacing: "normal"
  navigation:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 520
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.68rem"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "0.035em"
  mobileBrand:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 760
    lineHeight: 1
    letterSpacing: "-0.035em"
  mobileDisplay:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(3.15rem, 14vw, 3.55rem)"
    fontWeight: 790
    lineHeight: 1.03
    letterSpacing: "-0.04em"
  mobileLedgerTitle:
    fontFamily: "Noto Sans SC Variable, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 760
    lineHeight: 1.08
    letterSpacing: "-0.035em"
rounded:
  square: "0"
  precise: "1px"
  full: "999px"
spacing:
  xs: "5px"
  sm: "10px"
  md: "20px"
  lg: "32px"
  xl: "48px"
  section: "60px"
components:
  edition-tag:
    backgroundColor: "{colors.signal-cobalt}"
    textColor: "{colors.cool-paper}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "5px 10px"
  event-index-primary:
    backgroundColor: "{colors.signal-cobalt}"
    textColor: "{colors.cool-paper}"
    rounded: "{rounded.square}"
    size: "40px"
  static-preview-label:
    backgroundColor: "transparent"
    textColor: "{colors.signal-cobalt}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
  settings-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.muted-copy}"
    rounded: "{rounded.square}"
    height: "44px"
---

# Design System: DailyNews

## Overview

**Creative North Star: “晨间调度台”**

DailyNews 应像一张每天准时铺开的晨间调度单：有秩序、有节奏、可以迅速定位，却不制造控制室式的紧张感。冷白纸面承载石墨色信息，钢灰刻度建立结构，钴蓝只在真正需要提醒注意的节点发出信号。

系统的高级感来自比例、对齐、留白与精密线路，而不是渐变、玻璃拟态、发光或大面积装饰。它服务于“早晨快速浏览、空闲时间继续深读”的双阶段阅读习惯；拒绝新闻门户卡片墙和带有生成式 AI 气质的仪表盘。

**Key Characteristics:**

- 冷白纸面与极淡坐标网格形成安静的工作表材质。
- 方角、细线、编号、站点与线路构成稳定的“调度”语法。
- 单一钴蓝信号只标记当前、重点或可关注的信息。
- 高密度信息通过明确分区和克制字号保持可扫读性。
- 中文无衬线正文配合等宽微标签，兼顾亲和与精确。

## Colors

色彩系统以冷白与石墨为主，钢灰负责结构，钴蓝负责唯一的主动信号。

### Primary

- **调度钴蓝**（`signal-cobalt`）：用于当前进度、首要事件、领域信号条、线路已读段和重点微标签；不可扩展为大面积背景色。

### Neutral

- **冷白纸面**（`cool-paper`）：页面与组件的统一底色，也是线路站点的“纸面打孔”填色。
- **石墨正文**（`graphite-ink`）：标题、正文骨架和主线路，确保新闻阅读有足够对比度。
- **钢灰刻度**（`steel-marker`）：未激活节点、连接线和次级编号，表达机械但不冰冷的秩序。
- **低声说明**（`muted-copy`）：日期、状态、辅助解释和页脚声明。
- **结构分隔线**（`divider` / `divider-soft`）：分别用于主分区与行内分隔；通过透明度而非阴影建立层次。

**The One Signal Rule.** 每个屏幕只允许钴蓝承担主动强调；不要新增第二个强调色来区分领域。

**The Paper First Rule.** 大多数画面必须保持冷白纸面可见，石墨与钢灰建立信息秩序，色彩不应主导阅读。

## Typography

**Display Font:** Noto Sans SC Variable（后备为 PingFang SC、Microsoft YaHei、sans-serif）
**Body Font:** Noto Sans SC Variable（相同中文系统后备）
**Label/Mono Font:** ui-monospace（后备为 SFMono-Regular、Menlo、Consolas、monospace）

**Character:** 主字体厚实、直接而不过度品牌化，适合长时间中文阅读；等宽字体只出现在日期、编号、状态和短标签中，让界面带有调度单的精密感。

### Hierarchy

- **Display**（790，`display`，1.03）：仅用于页面级“今日简报”等大标题，保持紧凑字距与单行力量。
- **Headline**（700，`headline`，1.4）：用于主要分区标题和洞察标题。
- **Title**（700，`title`，1.4）：用于四个领域名称和重点事件标题。
- **Body**（400，`body`，1.72）：用于新闻正文、展开分析与术语解释；以 16px 为普通阅读基准，行长控制在约 30–55 个中文字符的阅读区间。
- **Supporting**（400，`supporting`，1.65）：用于首屏事件摘要、领域摘要和趋势雷达等需要保持扫读密度的辅助正文；不得承担长篇深读内容。
- **Label**（650，`label`，0.035em）：用于代码、计数、站点序号与状态；内容必须短，避免整段文字等宽化。

**The Two Voices Rule.** 阅读内容只用中文无衬线，系统刻度只用等宽字体；不要引入第三套展示字体制造“杂志感”。

## Layout

桌面端容器最大宽度为 1920px，顶部品牌栏与主体共用一条连续的水平骨架。首屏主体采用约 38/62 的双栏：左栏负责“今日简报”和三件大事，右栏负责四条领域线路；两栏始终共同决定总览区高度，右侧四条线路均分除标题栏外的可用空间，使两列顶底持续对齐。底部三栏洞察条形成收束。左栏与主分区用 1px 分隔，不使用浮动卡片。

间距遵循紧凑信息内部、小节之间明显拉开的节奏：5–10px 用于标签和微关系，20–32px 用于组件内部，48–60px 用于页面级区段。大屏标题和内容边距可使用 `clamp()` 平滑伸缩。新闻“完整分析”以稳定的两列阅读网格组织，栏间使用留白而非穿过长文本的竖向分隔线；影响链、术语和趋势使用各自的顶部细线建立起点，900px 以下改为单列。

在 1180px 以下，阅读进度移入第二行并压缩站点字号；在 900px 以下，双栏改为纵向堆叠，洞察条由三栏改为单栏；在 620px 以下，页边距收敛至 18–20px，阅读进度只保留当前步骤，领域线路仍保持五站并允许标签自然换行。移动端不得依靠横向滚动才能读完核心信息。

**The Fixed Route Rule.** 四个领域都使用同样的五站网格，使用户能靠位置形成稳定的阅读记忆。

## Elevation & Depth

系统不使用阴影。深度完全由冷白纸面的轻微网格、1px 主次分隔线、文字权重和钴蓝信号层级构成；所有内容都像印刷在同一张工作纸上，而不是漂浮在不同卡片上。

**The Flat By Default Rule.** 静态与交互状态都保持平面；需要强调时改变线条、前景色或填充，不抬升表面。

## Shapes

核心形状是方角矩形、正方编号块与精密直线。标签、分区和按钮均保持直角（`square`）；仅线路站点、未读点等真正表示“节点”的元素使用完整圆形（`full`）。极小的 1px 圆角（`precise`）只用于图标内部，不能演变为普遍圆角卡片。

边框以 1px 为主，线路主干可使用 2px；图标采用方形端点与斜接转角。避免胶囊按钮、大圆角容器和软萌图标，它们会破坏调度单的精确性。

## Components

### Navigation

- **Style:** 顶部品牌、日期、阅读进度和设置入口共享 76px 左右的水平栏；品牌以大号粗体承担视觉锚点。
- **Progress route:** 圆形节点以细钢灰线连接；当前节点填充钴蓝并加重文字，其余节点保持低声。
- **Mobile:** 隐藏非当前步骤，只显示当前名称与“01 / 04”计数，避免产生横向溢出。
- **Focus:** 可交互品牌链接使用 2px 钴蓝外轮廓和 4px 外偏移，轮廓不改变布局。

### Tags / Micro Labels

- **Edition tag:** 方角、等宽、小字号；普通标签是纸面底加细边框，示例状态使用钴蓝底和冷白字。
- **Static preview label:** 透明背景、钴蓝等宽字，用于诚实说明当前入口或内容尚为静态预览。
- **Status:** 未读状态以 8px 钴蓝圆点配合文字呈现，不能只依赖颜色传达含义。

### Event Rows

- **Structure:** 40px 方形序号块加标题和摘要，行间用柔和分隔线分开。
- **Priority:** 只有首要事件使用钴蓝实心序号块；其余序号使用半透明钢灰底。
- **Density:** 摘要较标题明显更轻、更小，确保晨间扫读时先看到事件名称。

### Domain Routes

- **Signature:** 每个领域由 5px 钴蓝信号条、领域标题、等宽代码、五站线路和一句摘要组成。
- **Route:** 石墨色 2px 主线承载五个 16px 节点；首段钴蓝线在进入视图时以 800ms 的快速减速动画展开。
- **Motion:** 使用 `cubic-bezier(0.16, 1, 0.3, 1)`；遵守 `prefers-reduced-motion`，关闭后必须仍能完整理解状态。
- **Mobile:** 五站保持同一行网格，标签允许换行，不裁切为省略号。

### Insight Containers

- **Structure:** 三个等宽栏直接铺在纸面上，以主分隔线连接；不使用独立卡片底色。
- **Icon:** 44px 线性钴蓝图标，方形端点、无填充，与标题和短解释形成三列结构。
- **Responsive:** 900px 以下堆叠为单列，并以水平分隔线继续保持秩序。

### Disabled Settings Control

- **Shape:** 透明、方角、44px 最小高度，左侧用分隔线与品牌栏区分。
- **State:** 静态首版保持禁用和较低不透明度，并提供明确提示；不能做成看似可点击却无响应的控制。

## Do's and Don'ts

### Do:

- **Do** 用钴蓝标记当前、首要或需要继续关注的单一信号，并让大部分纸面保持中性。
- **Do** 用 1px 分隔线、对齐、编号和固定五站网格组织密集信息。
- **Do** 保持“先总览、后领域、再洞察”的阅读层级，并让移动端无需横向滚动。
- **Do** 对示例、预测和未启用入口做可见且诚实的状态标注。
- **Do** 为所有运动提供无动画的等价状态。

### Don't:

- **Don't** 把首页改成由独立圆角卡片组成的新闻门户或 AI 仪表盘。
- **Don't** 使用渐变、玻璃拟态、霓虹发光、装饰性阴影或多种强调色制造“高级感”。
- **Don't** 大面积使用等宽字体；它只属于微标签、编号与系统状态。
- **Don't** 用插画、照片或装饰图形抢占新闻本身的注意力。
- **Don't** 把静态预览伪装成可操作入口，也不要把推测包装成已确认事实。
