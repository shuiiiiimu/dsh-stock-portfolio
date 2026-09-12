/**
 * Standalone type surface for the DSH pieces this plugin touches.
 *
 * These are ambient declarations, not a dependency: the package never imports
 * a DSH runtime value. The host half imports `@deepseek-ai/cordis` for the
 * `Context` type only, and the browser half imports only `react` plus the
 * `@deepseek-ai/dsh-client-ui-primitives` module the shell seeds into its
 * frozen module table — everything else is `import type`, which the bundler
 * erases.
 *
 * Declaring the contract locally keeps this repo buildable on its own, and
 * doubles as documentation of exactly which harness surface the plugin relies
 * on. Each block names the shipped file it mirrors.
 *
 * This file must stay a global script: an ambient `declare module` block stops
 * being ambient the moment the file gains a top-level import or export.
 */

/** Mirrors `packages/client/ui-slots` (the SlotMap and its prop algebra). */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** One registration site's spec, as it appears in the generated catalog. */
  interface SlotMap {
    /**
     * Declared by ui-layout's root entry; the frame-wide floating layer.
     * Entries order among themselves and opt into pointer events.
     */
    'shell.overlay': { kind: 'list', scope: 'root' }
    /**
     * Declared by ui-sidebar's `sidebar` entry; rendered ABOVE the Settings
     * seat. `sidebar.footer.action` is a list, so a fresh id is additive.
     */
    'sidebar.footer.action': { kind: 'list', scope: 'root', owner: SidebarFooterActionOwnerProps }
  }

  /** Owner share of a sidebar footer action: the column display state. */
  interface SidebarFooterActionOwnerProps {
    /** Whether the sidebar renders wide content (false = 56px rail). */
    wide: boolean
  }

  /** Runtime owner values for one slot key. */
  type PropsRuntime<K extends keyof SlotMap> =
    SlotMap[K] extends { owner: infer O } ? O : Record<string, never>

  /** The `inject` factory's return value, projected into component props. */
  type InjectFace<I> = I & {
    /** Observable sources promoted to `use<Name>(selector)` props. */
    readonly hooks?: Record<string, unknown>
  }

  /** Localized `t` derived from the registration's locale namespace. */
  type PropsLocale<_N extends string> = {
    t: (key: never, params?: Record<string, unknown>) => string
  }
}

/** Mirrors `packages/client/ui-sidebar/src/client/contract/slots.ts` (type-only). */
declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {}

/** Mirrors `packages/client/ui-layout/src/client/contract.ts` (type-only). */
declare module '@deepseek-ai/dsh-client-ui-layout/client' {}

/**
 * The `/` menu's command surface. Type-only: the contribution's shape is
 * declared structurally in `src/client/review-command.ts`, and this block exists
 * so that module resolves without a dependency on the harness package.
 * Mirrors `packages/client/ui-commands/src/client/contract.ts`.
 */
declare module '@deepseek-ai/dsh-client-ui-commands/client' {}

/** Mirrors `packages/client/ui-conversation/src/client/index.ts` (type-only). */
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {}

/** Mirrors `packages/client/locale/src/client/index.ts` (type-only). */
declare module '@deepseek-ai/dsh-client-ui-locale/client' {}

/** Mirrors `packages/client/ui-session/src/client/index.ts` (type-only). */
declare module '@deepseek-ai/dsh-client-ui-session/client' {}

/**
 * Mirrors the seeded platform module table
 * (`packages/client/web/src/seed.ts`). Only these specifiers may stay external
 * in a client bundle; the ones used here are declared structurally rather than
 * enumerated, because the shell owns the exact component set.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** Props every icon component accepts. */
  interface IconProps {
    size?: number | undefined
    className?: string | undefined
  }
  /** A thin-stroke 16px icon. */
  type Icon = (props: IconProps) => import('react').ReactElement
  export const IconRefreshOutline16: Icon
  export const IconSettingsOutline16: Icon
  export const IconCloseOutline16: Icon
  export const IconPlusOutline16: Icon
  export const IconTrashOutline16: Icon
  export const IconCheckOutline16: Icon
  export const IconWarningOutline16: Icon
  export const IconChevronDownOutline14: Icon
  export const IconChevronUpOutline14: Icon
  export const IconLinkOutline16: Icon
  export const IconLoadingOutline16: Icon
  export const IconEllipsisOutline16: Icon
  export const IconEditOutline16: Icon
  export const IconSearchOutline16: Icon
  export const IconDownloadOutline16: Icon
  /** A gauge: used for the portfolio-review command row. */
  export const IconGaugeOutline16: Icon
  /** Hover tooltip wrapper. */
  export const Tooltip: (props: {
    label: string
    side?: 'top' | 'bottom' | 'left' | 'right'
    delayMs?: number
    disabled?: boolean
    children?: import('react').ReactNode
  }) => import('react').ReactElement
}

/** Mirrors `packages/host/webserver/src/index.ts` (`WebRoute`). */
declare module '@deepseek-ai/dsh-host-webserver' {
  export type WebRouteKind = 'exact' | 'prefix'
  export interface WebRoute {
    kind: WebRouteKind
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }
}

/** Mirrors the cordis `Service`/`Context` surface this plugin consumes. */
declare module '@deepseek-ai/cordis' {
  /** The plugin context handed to `apply`. */
  interface Context {
    /** Register a fiber-owned disposer. */
    effect(work: () => (() => void | Promise<void>) | void, label?: string): void
    /** Read an optional service, or `undefined` when absent. */
    get(name: string): unknown
    /** Publish a service other plugins can read. */
    provide(name: string, value: unknown): void
    /**
     * Listen to a harness Event. The subscription belongs to the calling fiber
     * and is removed when it unloads, so no explicit disposer is kept.
     */
    /**
     * Run `callback` once these services exist, on a fiber owned by the caller —
     * the harness's own optional-registration path (`schedule` uses it for
     * `sessionProjections`). Needed because a plugin row may be applied before
     * the package that provides the service, and a one-time `get` would silently
     * register nothing.
     */
    inject(deps: readonly string[], callback: (scope: Context) => void): () => void
    /** The DSH Web server route registry. */
    readonly webServer: {
      register(route: import('@deepseek-ai/dsh-host-webserver').WebRoute): () => void
    }
    /** The browser slot registry (client half only). */
    readonly slots: {
      inject(key: string, callback: () => unknown): void
      register(options: Record<string, unknown>, component: unknown): unknown
    }
    /** The client locale registry (client half only). */
    readonly locale: {
      register(namespace: string, dictionaries: Record<string, unknown>): () => void
    }
    /** The `/` menu's command registry (client half only; may be absent). */
    readonly commandUi?: unknown
  }
}
