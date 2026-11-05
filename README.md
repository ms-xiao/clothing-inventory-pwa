# 衣记 · 小店进销存

面向 iPhone、iPad 的轻量服装进销存 PWA。纯 HTML、CSS、JavaScript，无运行时依赖，无服务器、账号或云同步。启动时为空账本，不会写入演示数据。

## 本地运行

需要 Node.js 20 或以上：

```sh
npm start
```

打开 <http://localhost:4173/clothing-inventory-pwa/>。应用本身不需要安装 npm 依赖；请通过 HTTP 访问，不要直接双击 HTML。Service Worker 仅在 HTTPS 或 localhost 下可用。

## 使用

1. 在「库存」添加商品。每条商品对应一个货号、颜色、尺码组合，初始库存为 0。同一货号的其他规格可继续添加。
2. 在「进货」选择规格并登记数量。进货金额按商品当前进价记录，进价变化请先编辑商品。
3. 在「销售」填写数量和实际单件售价。库存不足时拒绝整笔销售。
4. 「库存」可按名称、货号、颜色、尺码搜索；「记录」可筛选进货和销售历史。
5. 在「设置」导出 JSON 备份。恢复前会校验文件并显示商品、记录数量，确认后整体覆盖本机数据；取消不会变更数据。

金额以人民币计，最多两位小数，内部使用整数分。单价范围 0～999,999.99 元，单次数量 1～999,999 件；单规格库存最多 999,999,999 件。每个货号、颜色、尺码组合唯一（去首尾空白和 Unicode NFC 后区分大小写）。第一版不提供直接改库存、删除商品或删除流水，库存只随进销登记变动。

## 安装与离线

在 iOS/iPadOS Safari 中打开 HTTPS 地址，使用「分享 → 添加到主屏幕」。首次联网打开并等顶部显示「离线可用」，以后可离线打开、登记、搜索和备份。所有字体、脚本、图标均来自本站，不使用外部 CDN。

应用更新会显示「更新应用」，用户主动更新后才激活新缓存；未提交的表单会提示确认。缓存与部署子路径绑定，版本更新需要递增 `sw.js` 的 `VERSION`。

目标浏览器为 iOS/iPadOS Safari 16.4+ 及现代 Chromium。自动化测试运行真实 Chromium，不代表已完成 iPhone/iPad Safari 真机验收。

## 数据与备份

- IndexedDB：`clothing-inventory-pwa`，版本 1，`products` 与 `movements` 两张表。
- 进货/销售在覆盖两表的单一 `readwrite` 事务中重新读取库存、校验、写库存与流水。多个标签页也不能超售；事务完成才显示成功。
- 商品编辑保留稳定 ID 和库存；流水保留登记时的商品信息与价格，不随商品编辑变化。
- 导出通过跨两表的同一只读事务取得一致快照。格式为 `{app, version, exportedAt, products, movements}`，`app` 为 `clothing-inventory-pwa`，`version` 为 `1`。
- 恢复校验本应用 JSON 备份的字段、金额、数量、ID 与规格唯一性、引用、总额、库存和流水净额；通过后原子替换两表，失败保留旧数据。大型备份的读取和校验依赖设备可用内存。
- 数据仅属于当前设备、浏览器和来源地址。无痕模式、清除网站数据或系统回收存储可能导致丢失，请定期导出到「文件」等安全位置。网站没有后端，不能替用户找回未备份的数据。备份包含进价，请妥善保管。

## 测试

测试依赖仅用于开发，不随应用发布：

```sh
npm ci
npx playwright install --with-deps chromium
npm test
```

测试启动本地服务器，在真实浏览器中验证 IndexedDB 事务、库存增减、超售回滚、非法输入、多规格、并发、持久化、备份恢复、完整 UI 流程及 PWA 子路径离线打开。GitHub Actions 在 Pull Request 与 main 提交时执行。

## GitHub Pages

资源、manifest、Service Worker 均使用相对路径，支持 `https://ms-xiao.github.io/clothing-inventory-pwa/` 这样的项目子路径，不需要构建。

仓库包含 `.github/workflows/pages.yml`：main 及第一版开发分支 `feat/local-inventory-v1` 提交自动部署；也可在 Actions → Deploy GitHub Pages → Run workflow 中指定 `source_branch` 发布其他分支。同一个仓库只有一个 Pages 站点，开发分支部署会替换该预览。第一版合并后，可移除专用于该开发分支的触发条件。

首次启用需仓库允许 Pages/Actions 且具备相应权限。工作流会尝试启用 Pages；若组织策略阻止，请在 Settings → Pages 中选择 GitHub Actions。只有部署任务成功且实际 URL 可访问，才算部署完成。PR 未合并时 main 不包含第一版应用，合并后会自动部署。

## 文件结构

- `index.html` / `styles.css`：响应式界面与移动端底部导航。
- `js/app.js`：页面、输入、反馈和恢复确认。
- `js/db.js`：数据模型、原子事务、备份校验。
- `sw.js` / `manifest.webmanifest` / `icons/`：PWA 与离线资源。
- `scripts/serve.mjs`：只提供站点资源的本地预览服务器。
- `tests/`：真实浏览器验收。

## 当前范围

单设备本地账本；没有同步、账号、会员、支付、员工、多商户或复杂报表。第一版流水只追加，不提供退货、撤销、盘点调整或删除操作。大量商品和历史记录暂未分页。主屏幕安装、iOS 存储回收行为和长时间离线仍需在目标真机上进一步验收。
