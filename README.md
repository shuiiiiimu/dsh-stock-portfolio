# dsh-stock-portfolio

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里管理股票持仓：交易记录、盈亏统计、按日线保存的行情、离线代码检索与持仓复盘，全部落在本地 SQLite。

覆盖 A 股（沪深京）、港股、美股，以及 ETF、指数、可转债等标的。侧边栏底部「设置」上方会出现「股票持仓」入口，点开是一个管理面板；界面只用 DSH 自己的主题变量（`--dsw-alias-*`），自动跟随浅色 / 深色主题。

![股票持仓面板：左侧五个分区，右侧交易记录；侧边栏底部是插件入口与当日盈亏](docs/demo1.png)

<sub>截图：交易记录页。侧边栏底部是插件入口，面板内按分区切换，本图日线行情截至 2026-09-10。</sub>

## 功能

| 分区 | 内容 |
| --- | --- |
| **概览** | 持仓市值、总盈亏、浮动盈亏、当日盈亏、已实现盈亏、胜率；按每日收盘价回溯的市值走势图；市场分布与分币种小计 |
| **持仓** | 数量、成本价、最新收盘价（带日期）、当日盈亏、市值、浮动盈亏、已实现盈亏、仓位占比；表头可排序，底行合计 |
| **交易记录** | 增 / 改 / 删；表单默认折叠，动机字段旁**按方向给出常用速选词**（买入：低估值买入 / 财报超预期 / 回调加仓…，卖出：止盈 / 止损 / 估值过高…），点一下即填入，也可以自由输入 |
| **分析** | 已实现盈亏记在**卖出**动机上、浮动盈亏按买入动机的成本占比分摊，另有交易所分布、标的表现排行、清仓历史（含持有天数） |
| **设置** | 可选 API Key、基准货币、自动获取的汇率、行情刷新间隔、本地代码索引与批量请求状态 |

## 行情与口径

- **只按日线保存。** 每个标的每个交易日一行，没有分时、没有快照表。持仓按最新一个交易日的收盘价估值，「当日盈亏」是与前一交易日收盘价之差，界面上的价格永远带日期。
- **成本与盈亏不含手续费。** 移动加权平均成本：买入 `cost += 数量 × 价格`，卖出按摊薄成本结转并锁定已实现盈亏。核对券商的费用明细是另一件事，这里记的是「持仓花了多少、拿回多少」。
- **汇率自动获取，一天一次。** 每天第一次打开面板时通过 DSH 自己的 web 能力取 USD→CNY / USD→HKD（`ctx.web.fetch` 优先，失败退回 `ctx.web.search` 解析）；同一天内再打开不会再请求，想立刻更新点设置页的「获取最新」。基准货币默认**人民币 CNY**，汇率来源、汇率日期与更新时间在设置页可见，也可以手动覆盖。
- **代码检索在本地。** 每个交易所的全部标的（约 23,500 条）抓进本地 SQLite，每周更新一次，因此搜索立即返回、可离线、不消耗接口配额。代码写法：`600000.SH` / `00700.HK`（港股补足五位）/ `AAPL.US`；裸代码按形状推断交易所，并把推断结果显示出来。
- **行情数据源可配置。** 不填 Key 也能用（免费端点提供日线），填入 Key 会切到完整服务端点、获得更宽松的限流。Key 的四个来源按优先级为：管理后台设置 &gt; 环境变量 &gt; 项目目录 `.env` &gt; 插件行配置；设置页只回传「已配置 / 未配置」，从不回传密钥本身。

## 安装

插件是标准的 DSH **bundle** + **dual-face client**，两种装法：

```sh
npm install && npm run build

# 方式一（推荐）：装进 profile
dsh plugin --profile web add ~/codespaces/dsh-stock-portfolio
```

```yaml
# 方式二：profile 的 patch 层直接挂载本地 checkout。name 写相对路径即可，
# DSH 会以 patch 文件所在目录为基准解析，配置里不需要绝对路径。
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: stock-portfolio
      name: ../../../codespaces/dsh-stock-portfolio/lib/index.js
```

web profile 是 `patchReload: live`，保存后 Host 半边会重组；**浏览器需要刷新一次页面**（`window.__DSH_BOOT__` 在首页渲染时注入，HMR 只换行内容、不新增行）。

改完代码不用重启 `dsh`：

```sh
npm run build     # 额外写一份内容寻址的 lib/index.dev.<digest>.js
npm run reload    # 找到 profile → 把行指向最新的 dev 副本 → touch patch 触发重载
```

可选配置写在 profile 的 patch 行里：`dataDir`（默认 `$DSH_HOME/storages/stock-portfolio`）、`apiBase`、`apiKey`。

## 开发

```sh
npm run build      # lib/index.js（Host）+ lib/client.js（浏览器）+ 类型
npm run watch      # 监听 src/ 重建
npm run typecheck  # tsc --noEmit
npm test           # node --test，全部离线（行情与汇率接口都有 stub）
npm run reload     # 让运行中的 dsh 换用刚构建的 Host 半边
```

数据目录、`.env` 位置、dev 副本路径都在运行时按 `$DSH_HOME` / `import.meta.url` 推导；设置页显示的数据库路径会把 home 目录折叠成 `~`。仓库里没有任何硬编码的绝对路径。

## 已知边界

- 指数类裸代码有歧义（`000300` 既是沪深 300 的形状、也是深市股票的形状），需要写后缀或用搜索。
- 批量日线权限因套餐而异；没有权限时刷新会自动改为逐个代码请求，代码多时更慢。
- 不做汇率的历史回溯：市值走势图用**当前**汇率折算。
- 行情按交易日更新，美股与港股收盘时点不同，面板顶部会显示行情的最新日期。

## 开源协议与声明

- **License: MIT** — 见 [`LICENSE`](LICENSE)。
- **行情数据来自 [TickFlow](https://tickflow.org)（`api.tickflow.org` / `free-api.tickflow.org`）。** 本项目是第三方客户端，与 TickFlow 无隶属或合作关系，相关名称与商标归其各自所有者；接口行为可能随时变化。行情数据仅供个人参考，**不构成任何投资建议**，据此操作风险自负。
- **DSH 版本**：在 DSH `0.1.5-rc.2`（本地构建）上开发与验证。浏览器半边通过 shell 冻结的平台模块表解析 `react` / `@deepseek-ai/dsh-client-ui-*`，升级 DSH 后若该表有变动，需要同步 `scripts/build.mjs` 里的 externals 列表。
