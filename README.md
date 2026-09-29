# launch.arr.club — M1

AI startup launch board with revenue tracking. Pure static HTML/CSS/JS, zero build step —
deploy the folder as-is to Cloudflare Pages. Visual style: warm sticker-book (cream `#fffdf7`,
brand orange-red `#ee4518`, Baloo 2), shared with VidSizer's design family.

## What's built (M1)

| File | What it is |
|---|---|
| `index.html` | Hero ("Launch your AI startup. Get tracked."), Recently launched feed, How it works, pricing teaser, CTA |
| `submit.html` | 4-step wizard: ① product info (chips multi-select categories) → ② forced 5 story questions → ③ optional revenue (self-report fields + Stripe restricted-key placeholder) → ④ 3-plan picker (free+badge / $5 once / free nofollow) with badge 3-step subflow (style picker → code tabs HTML/React/AI prompt with `?ref=` → mock Verify → unlocks "Launch for free") |
| `launches/inkwell-ai/` | Sample detail: 💰 Revenue Tracked ($12k MRR self-reported), DR bar, 5-Q story, insights, related |
| `launches/taskflow-ai/` | Sample detail: ✓ Verified Revenue ($48k MRR via Stripe) |
| `launches/pixelpilot/` | Sample detail: no revenue badge (free tier example) |
| `2026/w40/`, `category/ai-writing/` | Weekly archive + category page templates |
| `sitemap.xml`, `robots.txt` | SEO basics; detail pages carry JSON-LD `SoftwareApplication` |

All sample listings are clearly marked "Sample data for preview". Nothing submits anywhere —
buttons that need a backend show a ⚙️ placeholder note.

## John 待办清单（上线前必须做）

1. **Google OAuth client ID** — `submit.html` 里搜 `googleBtn`，把占位 alert 换成真实 Google Identity Services 登录流（`https://accounts.google.com/gsi/client`）。
2. **收款链接** — `submit.html` 里搜 `payBtn`：$5 一次性收款。二选一：
   - Stripe Payment Link（最快，几分钟生成一个链接填进去），或
   - Dodo Payments（FasLaunch 用的 Merchant of Record，全球税务省心，印度开发者常用；你在美国/中国主体的话 Stripe 更直接）。
3. **Badge 验证 Worker** — `submit.html` 里搜 `verifyBtn`：现在是前端 mock（1.5 秒后假装通过）。
   真实逻辑需要一个 Cloudflare Worker：抓取提交者首页 HTML，检查是否含 `launch.arr.club/?ref=` 且链接无 nofollow/sponsored/ugc。每天再跑一次巡检 cron，两次缺失 → 下架回草稿。
4. **部署到 Cloudflare Pages** — 把本目录推到 GitHub 新仓库（或直接拖文件夹到 Pages），`Build command` 留空，`Output directory` 留空（纯静态）。
5. **子域名 DNS** — 在 arr.club 的 Cloudflare DNS 加 CNAME：`launch` → `xxx.pages.dev`。Pages 里绑定自定义域 `launch.arr.club`，HTTPS 自动。
6. **后端存储（M1 可先用最简方案）** — 提交数据现在只存在浏览器内存。最简可用：表单 POST 到
   [Formspree](https://formspree.io/) / Basin 等免费表单后端，John 收邮件手动发布；
   或 Telegram bot 收提交。等量起来再做数据库。

### 关于 DR 迁移（John 2026-09-29 问）

**诚实答案：DR 不会自动迁移。** Ahrefs 给子域名**单独算 DR**——
`launch.arr.club` 会从接近 0 开始，不会直接继承 `arr.club` 的 DR 41。
Google 也把子域名当相对独立的站点看排名，权重主要靠子域名自己的外链。

但有两条好消息：
1. `arr.club`（DR 41）链到子域名的链接权重传递很强（同根域名视为站内链接，有效传递）。
2. badge 飞轮本身就是给子域名涨 DR 的机器：每个免费 badge 用户的首页都是一个外链，
   FasLaunch 就是这么从 0 冷启动的。预计 3–6 个月把子域名 DR 养起来。

所以对外文案里**不要写 "DR 41 dofollow"**——写 "dofollow backlink" 即可，
等子域名自己的 DR 起来后再标数字。诚实是长期信任资产。

## M2 待做（等 M1 验证跑通）

- [ ] **$29 "Revenue Tracked" 档**：提交流程第 4 步加第四张卡；付费用 Stripe Payment Link；付款后自报 ARR 写入 arr.club（先手动，后脚本）。
- [ ] **Stripe 自动同步 Worker**：创始人粘贴 restricted key（只读）→ Cloudflare Worker 每天拉一次算 MRR → 写 Supabase/arr.club DB；key 存 Worker secrets；断开即删。隐私承诺文案已在 `submit.html` 写好。
- [ ] **Sponsor Card 广告位**：首页顶部卡片 $29/月（1–2 位，标 Sponsored），分类页 $19/月；购买入口放登录后订单页。
- [ ] **真实提交存储**：Supabase 免费档（表：launches / founders / badges / revenue_snapshots）。
- [ ] **每周 digest 邮件**：Resend 免费档（3000 封/月）发"本周新品 + 带收入数据的单独一区"。
- [ ] **Badge SVG 文件**：`/badges/badge-dark.svg`、`badge-light.svg`、`badge-green.svg`（M1 的代码引用了这三个 URL，部署前补上，或先用纯 HTML badge）。
- [ ] **IndexNow + GSC**：提交 sitemap，参考 VidSizer 的 SEO-PLAN 流程。

## 成功标准（M1 验证期）

- 2 周内 30+ 真实提交 → 需求成立
- 有人付 $5 或 10%+ 填收入 → 飞轮成立
- 4–6 周 GSC 出词 → SEO 路径成立
- 任一不成立就砍
