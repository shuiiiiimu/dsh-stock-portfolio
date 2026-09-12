# dsh-stock-portfolio

>对话是主要交互界面，面板只是必要时的管理入口。


在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里管理股票持仓：交易记录、盈亏统计、按日线保存的行情、离线代码检索与持仓复盘，全部落在本地 SQLite。覆盖 A 股（沪深京）、港股、美股，以及 ETF、指数、可转债。


三个入口，读写同一份数据：

- **侧边栏「股票持仓」**（「设置」上方，右侧直接带当日盈亏）→ 管理面板。
- **对话里读数据、记交易、复盘**：说「昨天买了 100 股腾讯」就写入，缺的字段当场弹一张问题卡片问；问「腾讯最近怎么样」「我在哪个动机上赚得多」时直接读本地 SQLite 回答；问「我的股票表现怎么样」会触发一次复盘（也可以直接敲 `/portfolio-review`）。读持仓、行情与聚合分析不用授权，读**交易记录明细**每次都会先弹一张授权卡片。`
- **对话右侧栏「持仓提及」**：对话里出现持仓标的的代码或名称时自动展开，列出它的走势与持仓统计。

界面只用 DSH 自己的主题变量（`--dsw-alias-*`），自动跟随浅色 / 深色主题。

![持仓：展开一行看走势与指标](docs/demo1.png)
![交易记录与动机](docs/demo2.png)
![面板与侧边栏入口](docs/demo3.png)

<sub>截图仅为效果预览，不构成投资建议。</sub>

## 面板

| 分区 | 内容 |
| --- | --- |
| **概览** | 持仓市值、总盈亏、未实现盈亏等指标；按每日收盘价回溯的市值走势图； |
| **持仓** | 数量、成本价、最新收盘价等；表头可排序。**每行可展开**可查看近期股价和分析统计。 |
| **交易** | 增 / 改 / 删；表单默认折叠，动机字段旁按方向给出常用速选词，点一下即填入，也可自由输入。 |
| **分析** | 已实现盈亏记在**卖出**动机上、浮动盈亏按买入动机的成本占比分摊。 |
| **设置** | API Key、基准货币、自动获取的汇率、本地代码索引状态等基础设置。 |

## 对话里提到持仓标的

对话里出现持仓标的的代码或名称时，右侧栏的「持仓提及」自己展开，一个标的一张卡片。

提及由一个会话投影折出：用户输入与助手回复都算，从磁盘恢复的历史会话在首次读取时把整段日志折一遍；浏览器每 2 秒问一次当前会话的状态（页面不可见时不问）。

## 在 chat 里读数据、记交易

同一个插件还向会话注册七个 Tool，读写同一份 SQLite：

| Tool | 权限 | 回答什么 |
| --- | --- | --- |
| `stock_add_trade` | 直接写入 | 把一句话变成一笔交易记录 |
| `stock_portfolio_overview` | 自动读 | 持仓明细、市值、浮动 / 已实现 / 当日盈亏、分币种小计 |
| `stock_symbol_detail` | 自动读 | 单个标的的本地日线与指标，外加它的持仓与清仓历史 |
| `stock_analysis` | 自动读 | 按动机、按市场的盈亏分布，标的表现排行。 |
| `stock_portfolio_review` | 自动读 | 组合复盘：当下的盈亏等，外加未来一个月的研究清单 |
| `stock_search_symbols` | 自动读 | 本地代码索引检索（离线、瞬时） |
| `stock_list_trades` | **先问用户同意** | 单笔交易明细：日期、方向、数量、价格、动机、备注 |

读持仓、读行情、读聚合分析、读复盘都不打断用户；**交易明细是唯一需要授权的读**。

### 复盘

问「我的股票表现怎么样」就会做一次持仓复盘：一次给全当下的数——盈亏、波动、集中度、浮盈浮亏家数、行情陈旧度。

也可以走斜杠菜单的「复盘持仓」（`/portfolio-review`，想只看一只就直接打 `/portfolio-review 腾讯控股`）。

## 口径

- **只按日线。** 每标的每交易日一行；估值用最新收盘价，「当日盈亏」对比前一日收盘价，界面上的价格永远带日期。
- **按需取数。** 最新一根已是数据源能给的最后交易日时不发请求，落后的只补缺口（`start_time` = 上次更新次日）。新标的（含 chat 里刚记的）写入时当场取最近 90 天。
- **成本与盈亏不含手续费**：移动加权平均，卖出按摊薄成本结转并锁定已实现盈亏。
- **汇率一天取一次**，基准货币默认人民币，也可在设置页手动覆盖。
- **数据源与代码索引**：不填 Key 也能用（免费端点提供日线），Key 的优先级为设置 > 环境变量 > `.env` > 插件行，设置页只回传「已配置 / 未配置」。

## 安装

插件是标准的 DSH **bundle** + **dual-face client**：

```sh
npm install && npm run build
dsh plugin --profile web add ~/codespaces/dsh-stock-portfolio      # 方式一
```

```yaml
# 方式二：profile 的 patch 层直接挂载本地 checkout（name 相对 patch 文件解析）
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: stock-portfolio
      name: ../../../codespaces/dsh-stock-portfolio/lib/index.js
```

web profile 是 `patchReload: live`，保存后 Host 半边会重组；浏览器需要刷新一次页面。改完代码不用重启 `dsh`：

```sh
npm run build     # 额外写一份内容寻址的 lib/index.dev.<digest>.js
npm run reload    # 把 profile 的行指向最新 dev 副本 → 触发重载
```

可选配置写在 patch 行里：`dataDir`（默认 `$DSH_HOME/storages/stock-portfolio`）、`apiBase`、`apiKey`。

## 开发

```sh
npm run build      # lib/index.js（Host）+ lib/client.js（浏览器）+ 类型
npm run watch      # 监听 src/ 重建
npm run typecheck  # tsc --noEmit
npm test           # node --test，全部离线
npm run reload     # 让运行中的 dsh 换用刚构建的 Host 半边
```

浏览器半边有三类用例：`client-bundle.test.mjs` 用桩模块表加载 `lib/client.js` 并真正执行 `apply`；`client-render.test.mjs` 用真实 React 渲染各分区；`client-mount.test.mjs` 在 jsdom 里挂载真实组件、让 effect 与请求跑完，断言点开一行之后线柱图与指标确实画了出来。

`npm run reload` 按「写同目录临时文件 → rename 覆盖 → 回读校验」替换 patch，并先确认目标 bundle 存在且非空。

## 已知边界

- 会话里能读持仓、行情、聚合分析与交易记录，但只能**新增**交易：改一笔、删一笔仍在面板里做。读交易明细每次都要用户点一次同意，没有明确同意就一条记录也不返回。
- 指数类裸代码有歧义（`000300` 既是沪深 300 的形状、也是深市股票的形状），需要后缀或搜索。
- 批量日线权限因套餐而异；没有权限时刷新会改为逐个代码请求，代码多时更慢。
- 不做汇率的历史回溯：市值走势图用**当前**汇率折算。
- 行情按交易日更新，美股与港股收盘时点不同，面板顶部显示行情的最新日期。

## 开源协议与声明

- **License: MIT** — 见 [`LICENSE`](LICENSE)。
- **DSH 版本**：在 DSH `0.1.5-rc.2`（本地构建）上开发与验证。
- **行情数据来自 [TickFlow](https://tickflow.org)。** 本项目是第三方客户端与 TickFlow 无隶属或合作关系，相关名称与商标归其各自所有者；个人用户注册可获取免费 API Key，行情数据仅供个人参考，**不构成任何投资建议**，据此操作风险自负。

