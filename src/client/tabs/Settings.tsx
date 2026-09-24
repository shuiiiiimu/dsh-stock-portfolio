/**
 * Settings: the optional market-data key, the reporting currency, the daily-refresh
 * policy, and the local instrument index.
 *
 * The key field is write-only by design — the host never sends a stored secret
 * back, so the input shows a presence flag rather than the value. The key is
 * also genuinely optional: every endpoint this plugin reads is served by the
 * keyless tier, so the section leads with that rather than implying a required
 * setup step.
 */
import { useEffect, useState } from 'react'
import {
  IconCheckOutlineRegular, IconLinkOutlineRegular, IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Banner, KeyValue, SectionTitle } from '../shared.tsx'
import { relative, timestamp } from '../format.ts'
import type { ApiKeySource, Currency, PortfolioSettings, QuoteFeedStatus } from '../../types.ts'

/** Where a key came from, in the user's terms. */
const KEY_SOURCE_LABEL: Readonly<Record<Exclude<ApiKeySource, 'none'>, string>> = {
  settings: '管理后台设置',
  env: '环境变量 TICKFLOW_API_KEY',
  dotenv: '项目目录下的 .env 文件',
  config: '插件行配置',
}

/** The three reporting currencies, in menu order. CNY leads: it is the default. */
const CURRENCIES: readonly { code: Currency, label: string }[] = [
  { code: 'CNY', label: '人民币 CNY（默认）' },
  { code: 'HKD', label: '港币 HKD' },
  { code: 'USD', label: '美元 USD' },
]

/**
 * Where the rates on screen came from, in the user's terms.
 * @param settings - the current settings, carrying the FX provenance.
 * @returns the label for the source row.
 */
function fxSourceLabel(settings: PortfolioSettings): string {
  const { source, provider, available } = settings.fx
  if (!available) return '未获取：当前 DSH 未挂载 web 服务'
  switch (source) {
    case 'web-fetch': return `自动获取（${provider ?? '汇率接口'}）`
    case 'web-search': return '自动获取（DSH web_search 解析）'
    case 'manual': return '手动填写'
    default: return '内置默认值（尚未刷新）'
  }
}

/** The settings patch the store accepts. */
interface SettingsPatch {
  apiKey?: string | null
  baseCurrency?: Currency
  usdHkd?: number
  usdCny?: number
  refreshIntervalMinutes?: number
  autoRefresh?: boolean
  mentionPopup?: boolean
}

/**
 * Render the settings section.
 * @param props - the current settings plus the store's actions.
 * @returns the section element.
 */
export function Settings({ settings, feed, busy, onSave, onRefresh, onRefreshRates, onSyncInstruments }: {
  settings: PortfolioSettings
  feed: QuoteFeedStatus
  busy: string | null
  onSave: (patch: SettingsPatch) => Promise<PortfolioSettings | null>
  onRefresh: (force: boolean) => void
  onRefreshRates: (force: boolean) => void
  onSyncInstruments: () => Promise<boolean>
}) {
  const [apiKey, setApiKey] = useState('')
  const [usdHkd, setUsdHkd] = useState(String(settings.rates.HKD))
  const [usdCny, setUsdCny] = useState(String(settings.rates.CNY))
  const [interval, setIntervalMinutes] = useState(String(settings.refreshIntervalMinutes))

  // A save from anywhere else rewrites the settings object; keep the numeric
  // drafts in step with it.
  useEffect(() => { setUsdHkd(String(settings.rates.HKD)) }, [settings.rates.HKD])
  useEffect(() => { setUsdCny(String(settings.rates.CNY)) }, [settings.rates.CNY])
  useEffect(() => { setIntervalMinutes(String(settings.refreshIntervalMinutes)) }, [settings.refreshIntervalMinutes])

  const saving = busy !== null
  const rateValid = Number(usdHkd) > 0 && Number(usdCny) > 0
  const intervalValid = Number(interval) >= 15

  /**
   * Persist the key field, which is the only secret on this page.
   * @param value - the key to store, or `null` to clear it.
   */
  const saveKey = async (value: string | null): Promise<void> => {
    const saved = await onSave({ apiKey: value })
    if (saved !== null) setApiKey('')
  }

  return (
    <div className="dsp-settings">
      <section>
        <SectionTitle note="可选，行情数据源">TickFlow API Key</SectionTitle>
        {feed.apiKeySource === 'none' && (
          <Banner tone="info">
            未配置 Key：使用 TickFlow <strong>免费服务</strong>，功能完整（本插件只用日线）；填入 Key 只是换成限流更宽松的端点。
          </Banner>
        )}
        {feed.lastError !== null && <Banner tone="error">{feed.lastError}</Banner>}

        <div className="dsp-settings-row">
          <label className="dsp-field-label" htmlFor="dsp-apikey">
            {settings.apiKeyConfigured ? '已配置（输入新值可替换）' : 'API Key'}
          </label>
          <div className="dsp-settings-inline">
            <input
              id="dsp-apikey"
              className="dsp-input"
              data-mono="true"
              type="password"
              autoComplete="off"
              placeholder={settings.apiKeyConfigured
                ? `当前来自${KEY_SOURCE_LABEL[settings.apiKeySource as Exclude<ApiKeySource, 'none'>]}`
                : '留空即使用免费服务'}
              value={apiKey}
              onChange={(event) => { setApiKey(event.target.value) }}
            />
            <button
              type="button"
              className="dsp-btn"
              data-variant="primary"
              disabled={saving || apiKey.trim() === ''}
              onClick={() => { void saveKey(apiKey.trim()) }}
            >
              <IconCheckOutlineRegular size={13} />
              保存
            </button>
            {settings.apiKeyConfigured && (
              <button
                type="button"
                className="dsp-btn"
                data-variant="danger"
                disabled={saving}
                onClick={() => { void saveKey(null) }}
              >
                清除
              </button>
            )}
          </div>
          <span className="dsp-field-hint">
            优先级：此处 &gt; <code>TICKFLOW_API_KEY</code> &gt; 项目 <code>.env</code> &gt; 插件行。
          </span>
        </div>
      </section>

      <section>
        <SectionTitle note="日线次日发布">行情刷新</SectionTitle>

        <div className="dsp-settings-row">
          <span className="dsp-field-label">后台检查间隔（分钟）</span>
          <div className="dsp-settings-inline">
            <input
              className="dsp-input"
              style={{ maxWidth: 140 }}
              inputMode="numeric"
              value={interval}
              onChange={(event) => { setIntervalMinutes(event.target.value) }}
            />
            <button
              type="button"
              className="dsp-btn"
              disabled={saving || !intervalValid}
              onClick={() => { void onSave({ refreshIntervalMinutes: Math.round(Number(interval)) }) }}
            >
              保存
            </button>
            <button
              type="button"
              className="dsp-btn"
              disabled={saving}
              onClick={() => { onRefresh(true) }}
            >
              <IconRefreshOutlineRegular size={13} className={busy === 'refresh' ? 'dsp-spin' : undefined} />
              立即刷新
            </button>
          </div>
          <span className="dsp-field-hint">
            已有最新交易日的股票不会被请求，落后的只补缺口；后台自动检查（最短 15 分钟，默认 360），打开面板时也会检查。
          </span>
        </div>

        <div className="dsp-settings-row">
          <span className="dsp-field-label">自动刷新</span>
          <div className="dsp-settings-inline">
            <button
              type="button"
              className="dsp-btn"
              data-variant={settings.autoRefresh ? 'primary' : 'ghost'}
              disabled={saving}
              onClick={() => { void onSave({ autoRefresh: !settings.autoRefresh }) }}
            >
              {settings.autoRefresh ? '已开启' : '已关闭'}
            </button>
          </div>
          <span className="dsp-field-hint">
            关闭后后台与打开面板都不再自动检查，只能点「立即刷新」。
          </span>
        </div>

        <div className="dsp-settings-row">
          <span className="dsp-field-label">会话提及时展开右侧栏</span>
          <div className="dsp-settings-inline">
            <button
              type="button"
              className="dsp-btn"
              data-variant={settings.mentionPopup ? 'primary' : 'ghost'}
              disabled={saving}
              onClick={() => { void onSave({ mentionPopup: !settings.mentionPopup }) }}
            >
              {settings.mentionPopup ? '已开启' : '已关闭'}
            </button>
          </div>
          <span className="dsp-field-hint">
            开启后，只要对话里提到已记录标的的代码或名称，对话右侧栏就会自动展开「持仓提及」，展示这些标的的走势、指标与持仓统计。
            关掉后提及仍会收集到那里，只是不会自动展开。
          </span>
        </div>

        <div style={{ marginTop: 14 }}>
          <KeyValue rows={[
            { label: '接口地址', value: feed.baseUrl },
            { label: '上次刷新', value: relative(feed.lastRefreshAt) },
            { label: '最新交易日', value: feed.latestDate ?? '尚无数据' },
            {
              label: '批量请求',
              value: feed.batchSupported
                ? '可用（每批 5 个代码）'
                : '当前 Key 无批量权限，已自动改为逐个代码请求',
            },
            {
              label: '未取到行情',
              value: feed.unresolved.length === 0 ? '无' : feed.unresolved.join('、'),
            },
          ]} />
        </div>
      </section>

      <section>
        <SectionTitle note="影响汇总口径">统计</SectionTitle>
        <div className="dsp-settings-row">
          <span className="dsp-field-label">基准货币</span>
          <div className="dsp-settings-inline">
            {CURRENCIES.map(option => (
              <button
                type="button"
                key={option.code}
                className="dsp-btn"
                data-variant={settings.baseCurrency === option.code ? 'primary' : 'ghost'}
                disabled={saving}
                onClick={() => { void onSave({ baseCurrency: option.code }) }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="dsp-field-hint">
            各标的按自身市场货币记账（CNY / HKD / USD），汇总时按下面的汇率折算。
          </span>
        </div>

        <div className="dsp-settings-row">
          <span className="dsp-field-label">汇率：1 USD = ?</span>
          <div className="dsp-settings-inline">
            <input
              className="dsp-input"
              style={{ maxWidth: 110 }}
              inputMode="decimal"
              aria-label="1 美元兑港币"
              value={usdHkd}
              onChange={(event) => { setUsdHkd(event.target.value) }}
            />
            <span className="dsp-field-hint">HKD</span>
            <input
              className="dsp-input"
              style={{ maxWidth: 110 }}
              inputMode="decimal"
              aria-label="1 美元兑人民币"
              value={usdCny}
              onChange={(event) => { setUsdCny(event.target.value) }}
            />
            <span className="dsp-field-hint">CNY</span>
            <button
              type="button"
              className="dsp-btn"
              disabled={saving || !rateValid}
              onClick={() => { void onSave({ usdHkd: Number(usdHkd), usdCny: Number(usdCny) }) }}
            >
              保存汇率
            </button>
            <button
              type="button"
              className="dsp-btn"
              disabled={saving}
              onClick={() => { onRefreshRates(true) }}
            >
              <IconRefreshOutlineRegular size={13} className={busy === 'refresh-rates' ? 'dsp-spin' : undefined} />
              获取最新
            </button>
          </div>
          <span className="dsp-field-hint">
            每天首次打开面板时自动取一次，当天不重复；手填的值会在下次自动刷新时被替换。
          </span>
          {settings.fx.error !== null && <Banner tone="error">{settings.fx.error}</Banner>}
          <div style={{ marginTop: 10 }}>
            <KeyValue rows={[
              { label: '基准货币', value: settings.baseCurrency === 'CNY' ? '人民币 CNY（默认）' : settings.baseCurrency },
              { label: '汇率来源', value: fxSourceLabel(settings) },
              {
                label: '汇率更新',
                value: settings.fx.updatedAt === null ? '尚未刷新' : relative(settings.fx.updatedAt),
              },
              { label: '汇率日期', value: settings.fx.asOf ?? '来源未提供' },
            ]} />
          </div>
        </div>
      </section>

      <section>
        <SectionTitle note="用于代码搜索与名称解析">本地代码索引</SectionTitle>
        <div className="dsp-settings-row">
          <div className="dsp-settings-inline">
            <button
              type="button"
              className="dsp-btn"
              disabled={saving}
              onClick={() => { void onSyncInstruments() }}
            >
              <IconRefreshOutlineRegular size={13} className={busy === 'sync-instruments' ? 'dsp-spin' : undefined} />
              立即重建索引
            </button>
            <span className="dsp-field-hint">
              {settings.instrumentCount === 0
                ? '尚未建立，首次刷新行情时会自动拉取'
                : `${String(settings.instrumentCount)} 个标的`}
            </span>
          </div>
          <span className="dsp-field-hint">
            全部标的（代码 + 名称）缓存在本地 SQLite，搜索即时、可离线、不消耗接口配额；每周自动更新。
            {' '}
            {settings.instrumentsSyncedAt === null
              ? ''
              : `上次更新：${timestamp(settings.instrumentsSyncedAt)}。`}
          </span>
        </div>
      </section>

      <section>
        <SectionTitle note="只读">存储</SectionTitle>
        <KeyValue rows={[
          { label: '数据库', value: settings.dbPath },
          { label: '存储引擎', value: 'SQLite（node:sqlite，WAL 模式）' },
          { label: '数据表', value: 'trades · holdings · prices · instruments · settings' },
          { label: '价格粒度', value: '每个标的每个交易日一行（日线）' },
          { label: '行情来源', value: 'TickFlow（api.tickflow.org / free-api.tickflow.org）' },
        ]} />
        <p className="dsp-field-hint" style={{ marginTop: 10 }}>
          <IconLinkOutlineRegular size={12} />
          {' '}
          行情数据由 TickFlow 提供，仅供个人参考，不构成投资建议。
        </p>
      </section>
    </div>
  )
}
