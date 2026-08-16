# dsh-notify-bell — Brand Spec（封面视觉系统）

一句话总结：沿用插件自带的 DSH Web 深色主题（#131722 深蓝底 + #4d6bfe 品牌蓝 + 细边框卡片 + Phosphor 铃铛），把 README 顶部横幅做成一张"既是产品横幅、又是 GitHub 分享卡片"的深色科技封面。

来源：`sound-showcase/styles.css` 的 dark theme tokens + 仓库 README / NOTICE（Phosphor Icons、react-sounds 素材署名）。

## 六个 OKLch tokens

| Token | Hex | OKLch |
|---|---|---|
| `--bg` | `#131722` | `oklch(0.2060 0.0247 293.0)` |
| `--surface` | `#1b1f2a` | `oklch(0.2404 0.0237 293.1)` |
| `--fg` | `#e7e9f0` | `oklch(0.9345 0.0105 293.8)` |
| `--muted` | `#7b8398` | `oklch(0.6107 0.0359 293.0)` |
| `--border` | `#323a4e` | `oklch(0.3498 0.0395 292.8)` |
| `--accent` | `#4d6bfe` | `oklch(0.5915 0.2382 293.2)` |

辅助色：accent-light `#86a0ff` `oklch(0.7263 0.1531 293.4)`；次文本 `#a4acbd` `oklch(0.7435 0.0279 292.4)`；亮文本 `#c9cfdc` `oklch(0.8538 0.0206 292.5)`；状态色 success `#6fd39a`、danger `#ff7a7a`、amber `#ffd166`、orange `#ff9e64`、sky `#7cc7ff`。

## 字体栈

- Body / UI：`"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif`
- Display（包名 / 技术标识）：`ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace`

## 观察到的视觉规则

1. 深色底 + hairline 细边框（1px `#323a4e`）+ 大圆角（12–16px）卡片，阴影很轻。
2. 品牌蓝只用于交互/选中状态与品牌强调，不铺满背景。
3. 五种语义事件各有一个低饱和状态色，其余文本走中性灰阶（fg → muted 三级）。
4. 包名、版本、路径一律等宽字体；正文 Segoe UI；中英文并列时英文主、中文辅。
5. 图标一律 Phosphor 轮廓风（沿用仓库现有 bell / bell-slash 体系）。
