# V1.1 实际运行截图

真实 Chromium 渲染，iPhone 390×844、iPad 1180×820。全部商品与进销数据仅在隔离的自动化测试浏览器中创建，应用不会初始化这些数据。截图不包含真实商户信息，不随 Pages 应用发布。

| 页面                 | iPhone                       | iPad                       |
| -------------------- | ---------------------------- | -------------------------- |
| 首页（01A 四块概览） | [查看](iphone-inventory.png) | [查看](ipad-inventory.png) |
| 款式详情             | [查看](iphone-detail.png)    | [查看](ipad-detail.png)    |
| 添加同款规格         | [查看](iphone-add.png)       | [查看](ipad-add.png)       |
| 进货                 | [查看](iphone-receive.png)   | [查看](ipad-receive.png)   |
| 销售                 | [查看](iphone-sell.png)      | [查看](ipad-sell.png)      |
| 进销记录             | [查看](iphone-history.png)   | [查看](ipad-history.png)   |
| 设置与备份           | [查看](iphone-settings.png)  | [查看](ipad-settings.png)  |
| 空账本               | [查看](iphone-empty.png)     | [查看](ipad-empty.png)     |
| 深色                 | [查看](iphone-dark.png)      | [查看](ipad-dark.png)      |

[320px 与 200% 文字压力检查](320-large-text.png)。页面长于视口时使用整页截图；弹层使用视口截图。截图关闭过渡动画以捕获稳定状态。

复现：`npm ci && npm test`；产物在 `test-results/screenshots/`。CI 任务另提供完整截图包。
