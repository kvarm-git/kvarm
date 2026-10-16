/** Shared server-rendered shell for signed-in and signed-out pages. */

import { escapeHtml, html, raw } from '@kvarm/ui';
import { siteName } from '../config';
import { cachedInboxCount, type InboxCount } from '../services/inboxCount';
import { sandboxBadgeCounts } from '../services/sandboxes';

const CRITICAL_CSS = raw(`
@media(prefers-reduced-motion:no-preference){@view-transition{navigation:auto}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--void,#050608);color:var(--bone,#e8e9e8);font-family:var(--f-sans,'Archivo',system-ui,sans-serif)}
`);

export interface PageOptions {
  title?: string;
  /** Signed-in login, when present. */
  userLogin?: string | null;
  /** Extra <head> content. */
  head?: string;
  /** Inline script module source (deferred). */
  script?: string;
  scriptUrl?: string;
  stylesheets?: string[];
  bodyClass?: string;
  landing?: boolean;
  contentInset?: boolean;
  active?: 'home' | 'inbox' | 'fleet' | 'tokens';
  needsYouCount?: number;
  inboxCount?: InboxCount | null;
  runningCount?: number;
  repos?: Array<{ ownerLogin: string; name: string }>;
  /** Request path: with APP_ORIGIN it becomes the canonical and og:url. */
  path?: string;
  description?: string;
  /** Server-rendered `?mode=` so a client without JavaScript gets the same view. */
  mode?: 'human' | 'agent';
  /** schema.org JSON-LD for the page. */
  jsonLd?: unknown;
}

const DEFAULT_DESCRIPTION =
  'Git for people and their agents: git smart-HTTP, a REST API, an MCP server and review pages on Cloudflare Artifacts.';

/** Identity metadata agents use for citations and previews; the Markdown twin is advertised on every page. */
function headMetadata(env: Env, opts: PageOptions, title: string): string {
  const origin = publicOrigin(env);
  const description = opts.description ?? DEFAULT_DESCRIPTION;
  const url = origin && opts.path ? `${origin}${opts.path}` : null;
  const markdown = opts.path === '/' ? '/index.md' : null;
  const lines = [
    `<meta name="description" content="${escapeHtml(description)}">`,
    url ? `<link rel="canonical" href="${escapeHtml(url)}">` : '',
    markdown ? `<link rel="alternate" type="text/markdown" href="${markdown}">` : '',
    '<link rel="describedby" type="text/markdown" href="/llms.txt">',
    '<link rel="service-desc" type="application/vnd.oai.openapi+json" href="/openapi.json">',
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${escapeHtml(siteName(env))}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    url ? `<meta property="og:url" content="${escapeHtml(url)}">` : '',
    origin ? `<meta property="og:image" content="${escapeHtml(`${origin}/assets/brand/og.png`)}">` : '',
    // `<` is escaped so page text can never close the script element.
    opts.jsonLd ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd).replace(/</g, '\\u003c')}</script>` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function publicOrigin(env: Env): string | null {
  const configured = env.APP_ORIGIN?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function requestOrigin(env: Env, requestUrl: string): string {
  return publicOrigin(env) ?? new URL(requestUrl).origin;
}

/** Hidden CSRF field for a session's state-changing forms; empty without a session. */
export function csrfInput(token: string | null | undefined): string {
  return token ? `<input type="hidden" name="_csrf" value="${escapeHtml(token)}" />` : '';
}

export function layout(env: Env, opts: PageOptions, body: string): string {
  return renderShell(env, { ...opts, contentInset: opts.contentInset ?? (opts.active !== 'home' && !opts.landing) }, body);
}

export interface AppLayoutOptions extends PageOptions {
  userId?: string | null;
}

export async function appLayoutCounts(
  env: Env,
  opts: Pick<AppLayoutOptions, 'userId' | 'needsYouCount' | 'runningCount' | 'inboxCount'>,
): Promise<Pick<PageOptions, 'needsYouCount' | 'runningCount' | 'inboxCount'>> {
  let needsYouCount = opts.needsYouCount ?? 0;
  let runningCount = opts.runningCount ?? 0;
  // Changes waiting for review join sandbox approvals: both need this human (services/inboxCount.ts).
  const inboxRead = opts.inboxCount !== undefined ? Promise.resolve(opts.inboxCount) : opts.userId ? cachedInboxCount(opts.userId) : Promise.resolve(null);
  if (opts.userId && (opts.needsYouCount === undefined || opts.runningCount === undefined)) {
    const counts = await sandboxBadgeCounts(env, opts.userId);
    if (opts.runningCount === undefined) runningCount = counts.running;
    if (opts.needsYouCount === undefined) needsYouCount = counts.needsYou;
  }
  const inbox = await inboxRead;
  return { needsYouCount, runningCount, inboxCount: inbox };
}

export async function appLayout(env: Env, opts: AppLayoutOptions, body: string): Promise<string> {
  return renderShell(env, { ...opts, ...(await appLayoutCounts(env, opts)) }, body);
}

function renderShell(env: Env, opts: PageOptions, body: string): string {
  const name = siteName(env);
  const login = opts.userLogin?.trim() ?? '';
  const signedIn = login.length > 0;
  const initial = login.slice(0, 1).toUpperCase() || '?';
  const title = opts.title && opts.title !== name ? `${opts.title} · ${name}` : name;
  const inboxWaiting = opts.inboxCount?.count ?? 0;
  const plus = inboxWaiting > 0 && opts.inboxCount?.more ? '+' : '';
  const badge = `${(opts.needsYouCount ?? 0) + inboxWaiting}${plus}`;
  const badgeHref = inboxWaiting > 0 ? '/inbox' : '/fleet#approvals';
  const badgeTitle = `${inboxWaiting}${plus} change(s) to review · ${opts.needsYouCount ?? 0} sandbox approval(s)`;
  const repoLinks = (opts.repos ?? [])
    .map(
      (repo) =>
        html`<a href="${raw(`/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}`)}"><span class="k-mono">${repo.ownerLogin}/${repo.name}</span></a>`,
    )
    .join('');
  const active = (page: PageOptions['active']) => (opts.active === page ? 'aria-current="page"' : '');
  const needsYou = html`<b>${badge}</b>`;
  const running = opts.runningCount === undefined ? '' : html`<span class="n">${opts.runningCount}</span>`;
  const landingNav = opts.landing
    ? html`<nav class="nav hud" aria-label="Primary">
        <a href="#how">How it works</a><a href="#product">Product</a><a href="#agents">Any agent</a>
      </nav>`
    : '';
  const mode = opts.landing
    ? html`<div class="mode" role="group" aria-label="Show this page for">
        <button type="button" data-mode-set="human" aria-pressed="true"><svg aria-hidden="true"><use href="#g-node"/></svg>Human</button>
        <button type="button" data-mode-set="agent" aria-pressed="false"><svg aria-hidden="true"><use href="#g-x"/></svg>Agent</button>
      </div>`
    : '';
  const headStyles = (opts.stylesheets ?? [])
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n');
  const customScripts = [
    opts.scriptUrl ? `<script src="${escapeHtml(opts.scriptUrl)}" type="module"></script>` : '',
    opts.script ? `<script type="module" defer>${opts.script}</script>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const header = signedIn
    ? html`<header class="k-top">
        <a class="brand" href="/" aria-label="${name} home"><svg class="mark" aria-hidden="true"><use href="#mark"/></svg><img class="wordmark-sm" src="/assets/brand/wordmark.svg" alt="" /></a>
        <div class="k-mid"><div class="k-ws"><i>${initial}</i><span>${login}</span></div></div>
          <div class="k-right">
          <span class="live-indicator" data-live-status data-state="offline" hidden>OFFLINE</span>
          <a class="k-needs" href="${raw(badgeHref)}" title="${badgeTitle}" aria-label="Needs you: ${badge}"><span>Needs you</span>${raw(needsYou)}</a>
          <div class="mode" role="group" aria-label="Show this app for">
            <button type="button" data-mode-set="human" aria-pressed="true"><svg aria-hidden="true"><use href="#g-node"/></svg>Human</button>
            <button type="button" data-mode-set="agent" aria-pressed="false"><svg aria-hidden="true"><use href="#g-x"/></svg>Agent</button>
          </div>
          <a class="k-me" href="/auth/logout" aria-label="Sign out">${initial}</a>
        </div>
      </header>`
    : opts.landing
      ? html`<header class="topbar">
          <div class="wrap topbar-in">
            <a class="brand" href="#top" aria-label="${name} home"><svg class="mark" aria-hidden="true"><use href="#mark"/></svg><span class="wordmark-sm">KVARM</span></a>
            ${raw(landingNav)}
            ${raw(mode)}
            <a class="btn btn-primary btn-sm m-human" href="/auth/login">Sign in</a>
            <a class="btn btn-hatch btn-sm m-agent" href="#connect">Connect</a>
          </div>
        </header>`
      : html`<header class="k-top k-top-slim">
          <a class="brand" href="/" aria-label="${name} home"><svg class="mark" aria-hidden="true"><use href="#mark"/></svg><img class="wordmark-sm" src="/assets/brand/wordmark.svg" alt="" /></a>
          <div class="k-right"><span class="live-indicator" data-live-status data-state="offline" hidden>OFFLINE</span><a class="btn btn-primary k-signin" href="/auth/login">Sign in</a></div>
        </header>`;
  const pageBody = opts.contentInset ? html`<div class="k-legacy-content">${raw(body)}</div>` : body;
  const content = signedIn
    ? html`<div class="k-shell">
        <aside class="k-rail" aria-label="App">
          <nav>
            <a href="/" ${raw(active('home'))}><svg aria-hidden="true"><use href="#g-home"/></svg>Home</a>
            <a href="/inbox" ${raw(active('inbox'))}><svg aria-hidden="true"><use href="#g-tray"/></svg>Inbox</a>
            <a href="/fleet" ${raw(active('fleet'))}><svg aria-hidden="true"><use href="#g-node"/></svg>Fleet${raw(running)}</a>
            <a href="/settings/tokens" ${raw(active('tokens'))}><svg aria-hidden="true"><use href="#g-x"/></svg>Tokens &amp; agents</a>
          </nav>
          ${repoLinks ? raw(html`<div class="k-repos"><h4 class="hud">Repos</h4>${raw(repoLinks)}</div>`) : ''}
          <div class="k-foot"><p class="hud">Signed in via WorkOS</p></div>
        </aside>
        <main class="k-main" id="main">${raw(pageBody)}</main>
      </div>`
    : opts.landing
      ? body
      : html`<main class="k-main" id="main">${raw(pageBody)}</main>`;
  const bodyClass = ['k-app', opts.bodyClass].filter(Boolean).join(' ');

  return html`<!DOCTYPE html>
<html lang="en" class="k-app"${raw(opts.mode ? ` data-mode="${opts.mode}"` : '')}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${raw(headMetadata(env, opts, title))}
<script>{const q=new URLSearchParams(location.search).get("mode");let m=q;try{m=m||localStorage.getItem("kvarm-mode")}catch{}document.documentElement.dataset.mode=m==="agent"?"agent":"human"}</script>
<style>${raw(CRITICAL_CSS.value)}</style>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/app.css">
<link rel="stylesheet" href="/assets/console.css">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<link rel="manifest" href="/assets/brand/site.webmanifest">
<meta name="theme-color" content="#050608">
${raw(headStyles)}
${raw(opts.head ?? '')}
<script src="/assets/mode.js" type="module"></script>
<script src="/assets/live.js" type="module"></script>
${raw(customScripts)}
</head>
<body class="${bodyClass}">
<svg class="k-sprites" aria-hidden="true" width="0" height="0">
  <symbol id="mark" viewBox="0 0 48 48"><path fill="currentColor" d="M5 4h9v40H5zM28 18.5 42.5 4H48v5.5L33.5 24 48 38.5V44h-5.5L28 29.5 33.5 24z"/><path d="M23 17.5 29.5 24 23 30.5 16.5 24z" style="fill:var(--node,var(--signal))"/></symbol>
  <symbol id="g-node" viewBox="0 0 5 5"><path fill="currentColor" d="M1 0h3v1H1zM0 1h1v3H0zM4 1h1v3H4zM1 4h3v1H1zM2 2h1v1H2z"/></symbol>
  <symbol id="g-x" viewBox="0 0 5 5"><path fill="currentColor" d="M0 0h1v1H0zM4 0h1v1H4zM1 1h1v1H1zM3 1h1v1H3zM2 2h1v1H2zM1 3h1v1H1zM3 3h1v1H3zM0 4h1v1H0zM4 4h1v1H4z"/></symbol>
  <symbol id="g-tray" viewBox="0 0 5 5"><path fill="currentColor" d="M1 0h3v1H1zM0 1h1v4H0zM4 1h1v4H4zM1 2h1v1H1zM3 2h1v1H3zM1 4h3v1H1z"/></symbol>
  <symbol id="g-home" viewBox="0 0 5 5"><path fill="currentColor" d="M2 0h1v1H2zM1 1h3v1H1zM0 2h5v1H0zM1 3h1v2H1zM3 3h1v2H3z"/></symbol>
</svg>
<p class="sr" id="mode-status" role="status" aria-live="polite"></p>
${raw(header)}
${raw(content)}
</body>
</html>`;
}
