/**
 * The `/portfolio-review` slash command, from the browser half.
 *
 * ## Why this row lives on the client
 *
 * The Host registry can register a command with no trouble, but a Host row
 * reaches the slash menu with only the English name and description it was
 * registered with: labels, icons and localized copy are client-owned, and the
 * only rows carrying them today are the first-party ones the command UI knows
 * by identity. A package outside the harness cannot join that list, so a
 * client-owned contribution is what makes this row read 「复盘持仓」 with an
 * icon instead of `portfolio-review` in English.
 *
 * The Host command is therefore gone rather than duplicated: a contribution
 * whose name collides with a Host command is refused loud, so the two cannot
 * coexist under one name — and the harness already executes unknown bare
 * commands, which keeps the typed form (`/portfolio-review 腾讯`) working with
 * the same model-facing instruction.
 *
 * ## What the pick does
 *
 * It writes the request into the composer as a draft instead of sending it: the
 * user sees exactly what is about to be asked, can add a focus (「只看腾讯」) or
 * delete it, and a mis-picked row costs nothing. The plugin contributes no
 * second review path — the prompt is the same sentence a person would type, and
 * `stock_portfolio_review` does the work either way.
 *
 * ## Types
 *
 * Everything crossing the package boundary is declared structurally, as the
 * rest of this plugin does it: the shapes below mirror
 * `@deepseek-ai/dsh-client-ui-commands/client`, and the module specifiers
 * resolve through `types/dsh.d.ts` rather than a dependency.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { IconGaugeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

/** The command's name, without the leading slash and stable across locales. */
export const REVIEW_COMMAND = 'portfolio-review'

/**
 * Chinese and English menu copy.
 *
 * The same two locales the harness's own dictionaries use; compared with a
 * prefix match because the preference is stored as a BCP 47 tag.
 */
const LABEL_ZH = '复盘持仓'
const DESCRIPTION_ZH = '复盘当前持仓：当下盈亏、风险与未来约一个月的催化'
const LABEL_EN = 'Portfolio review'
const DESCRIPTION_EN = 'Review your holdings: current P&L, risk, and the catalysts for the coming month'

/**
 * Ask for one review, in the words a user would use.
 *
 * Names the tool on purpose: the instruction is what makes a typed invocation
 * and a menu pick ask the same question, and it is the only place this plugin
 * has to keep in step with the tool's own description.
 */
export const REVIEW_PROMPT = '请复盘我的股票持仓。'
  + '先调用 stock_portfolio_review 拿到当下的数据，据它说清盈亏、波动、集中度与主要风险，并给出可执行的建议；'
  + '再用搜索 / 抓取工具查未来约一个月的走势与催化（行业竞争、券商预期 / 研报、业务进展、管理层变动、新闻动态），'
  + '标出信息日期与来源、区分事实与推测。回复克制，先结论后依据，不要长篇大论。'

/** One menu row's behavior; mirrors `CommandUiSpec`'s action kind. */
interface ActionSpec {
  readonly kind: 'action'
  run(session: { readonly sessionId: string }): void
}

/** One client-owned command row; mirrors `CommandContribution`. */
interface CommandContribution {
  readonly name: string
  readonly label?: () => string
  readonly description?: () => string
  readonly icon?: (props: { size?: number | undefined }) => unknown
  available(session: { readonly sessionId: string }): boolean
  readonly ui: ActionSpec
}

/** The client command registry; mirrors `ctx.commandUi`. */
interface CommandUiFace {
  register(contribution: CommandContribution): () => void
}

/**
 * The client locale registry's read face; mirrors `LocaleRuntime`.
 *
 * Both reader names are declared because the service carries each: `getSnapshot`
 * is the LocaleFace the render machinery consumes, `getLocale` the older
 * same-thing accessor. A wrong guess here does not fail loudly — it throws
 * inside the menu's candidate pass, which surfaces as "no slash commands at
 * all" rather than as a missing label.
 */
interface LocaleFace {
  getSnapshot?(): { readonly active?: string | undefined }
  getLocale?(): { readonly active?: string | undefined }
}

/** The sessions service's scope resolver; mirrors `ctx.sessions`. */
interface SessionsFace {
  scope(id: string): Context | undefined
}

/** The per-session composer; mirrors `SessionInputResolver` plus `SessionInput`. */
interface ConversationFace {
  readonly input: { for(actx: Context): { setDraft(text: string): void } }
}

/**
 * Whether the active locale asks for Chinese.
 *
 * Missing service, missing accessor and an unreadable snapshot all answer
 * "no": English is the harness's own fallback for a locale it cannot resolve,
 * and a thrown error here would take the whole `/` menu down with it.
 * @param ctx - the browser plugin context.
 * @returns true for the `zh` locale and anything falling back from it.
 */
function isChinese(ctx: Context): boolean {
  const locale = ctx.get('locale') as LocaleFace | undefined
  const active = locale?.getSnapshot?.().active
    ?? locale?.getLocale?.().active
    ?? 'en'
  return String(active).toLowerCase().startsWith('zh')
}

/**
 * Register the slash command, if this composition has a command surface.
 * @param ctx - the browser plugin context.
 */
export function applyReviewCommand(ctx: Context): void {
  ctx.inject(['commandUi'], (scope: Context) => {
    const commands = scope.get('commandUi') as CommandUiFace | undefined
    if (commands === undefined) return
    const contribution: CommandContribution = {
      name: REVIEW_COMMAND,
      // Read through on every candidate pass, so a language switch reaches the
      // next menu open without re-registering.
      label: () => (isChinese(scope) ? LABEL_ZH : LABEL_EN),
      description: () => (isChinese(scope) ? DESCRIPTION_ZH : DESCRIPTION_EN),
      icon: IconGaugeOutline16,
      // Reviewing is always applicable — an empty portfolio is a legitimate
      // answer, not a reason to hide the row.
      available: () => true,
      ui: {
        kind: 'action',
        run: (session) => {
          const sessions = scope.get('sessions') as SessionsFace | undefined
          const scoped = sessions?.scope(session.sessionId)
          const conversation = scoped?.get('conversation') as ConversationFace | undefined
          if (scoped === undefined || conversation === undefined) {
            // Reported rather than swallowed: the row is on screen and the
            // click did nothing, which is otherwise invisible.
            console.warn('[stock-portfolio] /portfolio-review has no composer to write into')
            return
          }
          conversation.input.for(scoped).setDraft(REVIEW_PROMPT)
        },
      },
    }
    scope.effect(() => commands.register(contribution), 'stock-portfolio: /portfolio-review command')
  })
}
