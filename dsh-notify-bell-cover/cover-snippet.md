# README 自动封面 — 使用说明（cover-snippet.md）

本目录包含 dsh-notify-bell 的 README 封面：深色科技风横幅，既是 README 顶部主视觉，也是 GitHub 分享链接的社交卡片（og:image）。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `readme-cover.svg` | 英文封面（纯静态，直接编辑此文件修改封面） |
| `readme-cover.zh.svg` | 中文封面（纯静态，直接编辑此文件修改封面） |
| `readme-cover.png` | 英文位图封面（2560×1280，2x），README.md 首图 / 社交卡片 |
| `readme-cover.zh.png` | 中文位图封面（2560×1280，2x），README.zh.md 首图 |
| `cover-snippet.md` | 本文件 |

## 1. 插入 README

在 `README.md` 顶部（语言链接与 badges 之后）加入：

```html
<p align="center">
  <img src="dsh-notify-bell-cover/readme-cover.png" alt="dsh-notify-bell — semantic sounds for DSH" width="100%" />
</p>
```

在 `README.zh.md` 顶部加入中文版：

```html
<p align="center">
  <img src="dsh-notify-bell-cover/readme-cover.zh.png" alt="dsh-notify-bell — DSH 语义通知插件" width="100%" />
</p>
```

> GitHub 会抓取 README 中的第一张图片作为分享卡片（og:image），PNG 兼容性最好。
> 更稳妥的做法：在仓库 **Settings → General → Social preview** 上传 `readme-cover.png`，分享卡片将固定使用这张图。

## 2. 修改封面

两个 SVG 均为纯静态文件，直接编辑其中的文字或图形即可，无需构建、渲染或安装依赖。中英文封面各自维护各自的文案。

## 3. PNG 导出

修改 SVG 后，用任意 SVG 渲染器按 2x（2560×1280）重新导出两个 PNG
（如 resvg、Inkscape 或设计工具），分别覆盖 `readme-cover.png` 与
`readme-cover.zh.png`，两份 README 首图与分享卡片即同步更新。
