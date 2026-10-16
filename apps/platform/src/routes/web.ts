/**
 * Generic web surface: landing/dashboard, repo creation + import, and the
 * token settings pages (PATs and agent tokens). Repository pages (tree, blob,
 * raw, commits, branches, settings) live in repoPages.ts and mount after these
 * routes at /:owner/:repo.
 *
 * Every state-changing form here is session-only and requires a same-origin
 * request plus the session's CSRF token (architecture §11.1). Token pages
 * reuse the existing token services; they add no token logic of their own.
 */

import { Hono, type Context } from 'hono';
import { html, raw, timeAgo } from '@kvarm/ui';
import { listReposForOwner } from '../db/repos';
import { listOwnedOrgLogins } from '../db/users';
import type { UserRow } from '../db/users';
import { csrfTokenValid, isSameOriginRequest, type SessionInfo } from '../auth/workos';
import { mintPAT, parseScopes, patListStatement, revokePAT, SCOPES, type PatListRow, type Scope } from '../auth/pat';
import { csrfInput, layout, requestOrigin, type PageOptions } from '../web/render';
import { CSRF_REFUSED } from './pageCsrf';
import * as svc from '../repos/service';
import * as agents from '../services/agents';
import { linkWorkOSIdentity } from '../services/identity';
import type { Actor } from '../services/authz';
import { listMyPendingApprovals, listMySandboxes } from '../services/sandboxes';
import { nexusField, type NexusArea, type NexusField } from '../services/nexusField';
import { landingPage } from '../web/landing';
import { homeJsonLd, homeMarkdown, prefersMarkdown, SUMMARY } from '../services/agentDiscovery';
import { requestSession, type App } from './api';

export const web = new Hono<App>();

interface PageCtx {
  session: SessionInfo | null;
  user: UserRow | null;
}

/** Narrowed context for routes that require a signed-in session. */
interface AuthedPageCtx {
  session: SessionInfo;
  user: UserRow;
}

type FormValue = string | File | (string | File)[];
type Form = Record<string, FormValue>;

/** Agents listed per account on the settings page; the rest are paged. */
const SETTINGS_AGENT_LIMIT = 50;
/** Organizations offered in the account switcher. */
const SETTINGS_ORG_LIMIT = 50;
/** PATs listed on the settings page. */
const SETTINGS_PAT_LIMIT = 200;

async function pageCtx(c: Context<App>): Promise<PageCtx> {
  const session = await requestSession(c);
  return { session, user: session?.user ?? null };
}

function page(
  c: Context<App>,
  ctx: PageCtx,
  title: string,
  body: string,
  status = 200,
  shell: Omit<PageOptions, 'title' | 'userLogin'> = {},
): Response {
  const pathname = new URL(c.req.url).pathname;
  const active = shell.active ?? (pathname === '/' ? 'home' : pathname.startsWith('/fleet') ? 'fleet' : pathname === '/settings/tokens' ? 'tokens' : undefined);
  const queryMode = c.req.query('mode');
  const mode = queryMode === 'agent' || queryMode === 'human' ? queryMode : undefined;
  return new Response(layout(c.env, { path: pathname, mode, ...shell, title, userLogin: ctx.user?.login ?? null, active }, body), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function errorPage(c: Context<App>, ctx: PageCtx, error: string, back: string, status: number): Response {
  return page(c, ctx, 'Error', html`<div class="flash err">${error}</div><a href="${back}">back</a>`, status);
}

async function requireSessionPage(c: Context<App>): Promise<AuthedPageCtx | Response> {
  const ctx = await pageCtx(c);
  if (!ctx.session || !ctx.user) {
    return c.redirect(`/auth/login?returnTo=${encodeURIComponent(new URL(c.req.url).pathname)}`);
  }
  return ctx as AuthedPageCtx;
}

function first(v: FormValue | undefined): string | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' ? x : undefined;
}

function every(v: FormValue | undefined): string[] {
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === 'string');
}

/**
 * A session's state-changing form post: same-origin, signed in, and carrying
 * the session's synchronizer CSRF token. Returns the parsed form.
 */
async function requireSessionForm(c: Context<App>): Promise<{ ctx: AuthedPageCtx; form: Form } | Response> {
  if (!isSameOriginRequest(c.req.raw, c.env)) return c.text('cross-origin request refused', 403);
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const form = (await c.req.parseBody({ all: true }).catch(() => ({}))) as Form;
  if (!csrfTokenValid(ctx.session, first(form._csrf))) return c.text(CSRF_REFUSED, 403);
  return { ctx, form };
}

function sessionActor(ctx: AuthedPageCtx): Actor {
  return { user: ctx.user, via: 'session', scopes: null };
}

async function runningSandboxCount(env: Env, actor: Actor): Promise<number | null> {
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await listMySandboxes(env, actor, { cursor, limit: 100 });
    if (!page.ok) return null;
    count += page.value.sandboxes.filter((sandbox) => sandbox.status === 'running' || sandbox.status === 'starting').length;
    cursor = page.value.nextCursor ?? undefined;
  } while (cursor);
  return count;
}

function iso(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toISOString();
}

/** Tile size and heat by rank: the busiest area is drawn largest. */
const AREA_SIZES = ['t-xl', 't-l', 't-m', 't-m', 't-s', 't-s', 't-s', 't-s', 't-s'] as const;

function areaClass(area: NexusArea, rank: number): string {
  const heat = area.overlapping ? 'k3' : area.agents.length > 1 ? 'k2' : area.declared + area.observed > 0 ? 'k1' : 'k0';
  return `t ${AREA_SIZES[rank] ?? 't-s'} ${heat}`;
}

function areaLabel(area: NexusArea): string {
  const who = area.agents.slice(0, 2).join(', ') + (area.agents.length > 2 ? ` +${area.agents.length - 2}` : '');
  const what = area.overlapping ? 'overlap' : area.declared > 0 && area.observed > 0 ? 'declared + observed' : area.declared > 0 ? 'declared paths' : 'observed changes';
  return who ? `${who} · ${what}` : what;
}

function repoHref(repo: string): string {
  return `/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

/** The Nexus field (services/nexusField.ts) in the landing mock-up's layout, from live data. */
function nexusPanel(field: NexusField): string {
  const scope = field.repos === 1 ? '1 repository' : `${field.repos} repositories`;
  if (field.activeWorkspaces === 0 && field.areas.length === 0) {
    return html`<section class="panel m-agent k-nexus" aria-labelledby="nexus-title">
      <div class="panel-head hud"><b id="nexus-title">Nexus · field</b><span>${scope}</span></div>
      <div class="k-panel-body">
        <p class="muted">No active agent workspaces in your repositories yet. When an agent declares an intent or pushes to its workspace, the paths it touches and any overlap appear here.</p>
        <pre class="code">kvarm workspace create &lt;owner&gt;/&lt;repo&gt; --task "…" --intent '{"paths":["src/"]}'
kvarm nexus forecast &lt;owner&gt;/&lt;repo&gt; --paths src/</pre>
      </div>
    </section>`;
  }
  const multiRepo = new Set(field.areas.map((a) => a.repo)).size > 1;
  const tiles = field.areas
    .map(
      (area, i) =>
        html`<a class="${areaClass(area, i)}" href="${raw(`${repoHref(area.repo)}/activity`)}"><b>${multiRepo ? `${area.repo} · ` : ''}${area.path}</b><span>${areaLabel(area)}</span></a>`,
    )
    .join('');
  const intents = field.intents
    .map((intent) => {
      const badge = intent.changeSet !== null ? String(intent.changeSet).padStart(2, '0') : '··';
      const state = intent.overlapping ? 'st4' : intent.changeSet !== null ? 'st3' : 'st2';
      const where = [intent.paths[0], intent.agent].filter(Boolean).join(' · ');
      return html`<li><span class="st ${state}">${badge}</span><div><b><a href="${raw(`${repoHref(intent.repo)}/activity#ws-${encodeURIComponent(intent.workspace)}`)}">${intent.task ?? intent.workspace}</a></b><span class="hud ident">${where}${multiRepo ? ` · ${intent.repo}` : ''}</span></div></li>`;
    })
    .join('');
  const overlapRows = field.overlaps
    .slice(0, 4)
    .map(
      (o) =>
        html`<p class="needs"><b>${o.agents[0] ?? o.workspaces[0]} ↔ ${o.agents[1] ?? o.workspaces[1]}</b> share ${o.pathCount} path${o.pathCount === 1 ? '' : 's'} (${o.paths.slice(0, 2).join(', ')}${o.pathCount > 2 ? ', …' : ''}) in <a href="${raw(`${repoHref(o.repo)}/activity#overlap`)}">${o.repo}</a>.</p>`,
    )
    .join('');
  return html`<section class="panel m-agent k-nexus" aria-labelledby="nexus-title">
    <div class="panel-head hud"><b id="nexus-title">Nexus · field</b><span>${scope} · ${field.activeWorkspaces} active workspace${field.activeWorkspaces === 1 ? '' : 's'}</span></div>
    <div class="field-body">
      <div class="territory" aria-label="Declared and observed codebase paths and advisory overlap">${raw(tiles || '<p class="muted">No declared or observed paths yet.</p>')}</div>
      <aside class="field-side">
        <section class="panel">
          <div class="panel-head hud"><b>Declared intents</b><span>${field.intents.length}</span></div>
          ${raw(intents ? `<ul class="intents">${intents}</ul>` : '<p class="needs">No declared intents.</p>')}
        </section>
        <section class="panel">
          <div class="panel-head hud"><b>Overlap</b><span>${field.overlaps.length} pair${field.overlaps.length === 1 ? '' : 's'} · advisory</span></div>
          ${raw(overlapRows || '<p class="needs">No overlapping workspaces reported.</p>')}
        </section>
      </aside>
    </div>
    ${field.partial.length > 0 ? raw(html`<p class="muted k-nexus-note">Partial for ${field.partial.join(', ')}: some reads were bounded or unavailable, so an empty area is not proof of no activity.</p>`) : ''}
  </section>`;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

web.get('/', async (c) => {
  // The same URL in Markdown for agents that ask for it; Vary keeps caches from mixing the two.
  if (prefersMarkdown(c.req.header('accept'))) {
    return new Response(homeMarkdown(c.env), { headers: { 'content-type': 'text/markdown; charset=utf-8', vary: 'Accept' } });
  }
  const ctx = await pageCtx(c);
  const origin = requestOrigin(c.env, c.req.url);
  if (!ctx.user) {
    const body = landingPage(origin);
    const res = page(c, ctx, 'The next-generation git platform', body, 200, {
      landing: true,
      bodyClass: 'k-landing',
      stylesheets: ['/assets/landing.css'],
      scriptUrl: '/assets/landing.js',
      description: SUMMARY,
      jsonLd: homeJsonLd(c.env, origin),
    });
    res.headers.set('vary', 'Accept');
    // The signed-out page must not be replayed by a heuristic cache on Back
    // after a sign-in: it would read as a session that vanished.
    res.headers.set('cache-control', 'no-store');
    return res;
  }

  const actor = sessionActor(ctx as AuthedPageCtx);
  const [repos, approvalsResult, runningCount] = await Promise.all([
    listReposForOwner(c.env.DB, ctx.user.login),
    listMyPendingApprovals(c.env, actor),
    runningSandboxCount(c.env, actor),
  ]);
  const field = await nexusField(c.env, repos, origin);
  const approvals = approvalsResult.ok ? approvalsResult.value : null;
  const pendingCount = approvals?.length ?? null;
  const mcpUrl = `${origin}/mcp`;
  const approvalRows = approvals?.map(
    (approval) => html`<a class="k-approval-row" href="/fleet#approvals">
      <span class="k-approval-repo hud">${approval.repo}</span><span class="k-approval-command">${approval.command}</span>
    </a>`,
  );
  const repoRows = repos
    .map(
      (repo) => html`<a class="dash-repo" href="/${repo.owner_login}/${repo.name}">
        <span class="dash-repo-top"><strong>${repo.name}</strong><span class="tag">${repo.visibility}</span></span>
        <span class="dash-repo-desc ${repo.description ? '' : 'muted'}">${repo.description ?? 'No description'}</span>
        <span class="dash-repo-meta hud">${repo.owner_login} · ${repo.pushed_at ? `pushed ${timeAgo(repo.pushed_at)}` : 'never pushed'}</span>
      </a>`,
    )
    .join('');
  const csrf = raw(csrfInput(ctx.session?.csrfToken));
  const humanHeading =
    pendingCount === null ? 'Approval status unavailable.' : pendingCount > 0 ? `${pendingCount} need you` : 'All clear.';
  const needsPanel =
    approvals === null
      ? html`<p class="muted">Could not load pending approvals right now.</p>`
      : approvals.length
        ? approvalRows!.join('')
        : html`<p class="muted">Nothing needs you right now.</p>`;
  // The approvals panel leads only when something is waiting; an empty queue is
  // already said by the heading and the top bar count.
  const needsSection = approvals === null || approvals.length > 0
    ? html`<section class="panel dash-needs">
        <div class="panel-head hud"><b>Needs you</b><span>${pendingCount ?? 'Unavailable'}</span></div>
        <div class="k-panel-body k-approval-list">${raw(needsPanel)}</div>
      </section>`
    : '';
  const body = html`
    <header class="k-head dash-head">
      <div class="k-head-copy">
        <p class="hud">Signed in as ${ctx.user.login}</p>
        <h1 class="m-human">${humanHeading}</h1>
        <h1 class="m-agent">Your agent workspace</h1>
        <p class="lede m-agent">Connect to MCP at <a class="k-mono" href="${mcpUrl}">${mcpUrl}</a></p>
      </div>
      <div class="k-head-side">
        <div class="k-kpis" aria-label="Account overview">
          <div><span class="hud">Repositories</span><b>${repos.length}</b></div>
          <div><span class="hud">Running sandboxes</span><b>${runningCount ?? 'Unavailable'}</b></div>
          <div><span class="hud">Pending approvals</span><b class="${pendingCount ? 'warn' : ''}">${pendingCount ?? 'Unavailable'}</b></div>
        </div>
      </div>
    </header>
    <section class="k-content">
      ${raw(nexusPanel(field))}
      <div class="k-grid">
        <div class="k-col">
          ${raw(needsSection)}
          <section class="dash-repos-section">
            <div class="dash-section-head"><h2>Repositories</h2><span class="hud muted">${repos.length}</span></div>
            ${raw(repoRows ? `<div class="dash-repos">${repoRows}</div>` : '<p class="muted dash-empty">No repositories yet. Create one or import a remote on the right.</p>')}
          </section>
        </div>
        <div class="k-col">
          <section class="panel m-agent">
            <div class="panel-head hud"><b>Connect an agent</b><span class="k-mono">MCP</span></div>
            <div class="k-panel-body">
              <p class="muted">Connect over MCP at <a class="k-mono" href="${mcpUrl}">${mcpUrl}</a>.</p>
              <pre class="code">kvarm repo list
kvarm sandbox mine --limit 50</pre>
            </div>
          </section>
          <section class="panel dash-new">
            <div class="panel-head hud"><b>New repository</b></div>
            <div class="k-panel-body">
              <form method="post" action="/new-repo">
                ${csrf}
                <label for="name">Name</label>
                <input id="name" name="name" type="text" required placeholder="my-project" />
                <label for="description">Description</label>
                <input id="description" name="description" type="text" placeholder="optional" />
                <label for="visibility">Visibility</label>
                <select id="visibility" name="visibility">
                  <option value="private">private</option>
                  <option value="public">public</option>
                </select>
                <p><button class="btn primary" type="submit">Create repository</button></p>
              </form>
              <details class="dash-import">
                <summary>Import from an HTTPS remote</summary>
                <form method="post" action="/import-repo">
                  ${csrf}
                  <label for="url">Remote URL</label>
                  <input id="url" name="url" type="url" required placeholder="https://example.com/owner/repo" />
                  <label for="iname">Name</label>
                  <input id="iname" name="name" type="text" placeholder="defaults to remote name" />
                  <p><button class="btn" type="submit">Import</button></p>
                </form>
              </details>
            </div>
          </section>
        </div>
      </div>
    </section>
  `;
  const res = page(c, ctx, 'Home', body, 200, {
    active: 'home',
    needsYouCount: pendingCount ?? undefined,
    runningCount: runningCount ?? undefined,
    repos: repos.map((repo) => ({ ownerLogin: repo.owner_login, name: repo.name })),
  });
  res.headers.set('vary', 'Accept');
  return res;
});

web.post('/new-repo', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const result = await svc.createRepo(c.env, {
    ownerLogin: ctx.user.login,
    name: first(form.name) ?? '',
    description: first(form.description) || null,
    visibility: first(form.visibility) === 'public' ? 'public' : 'private',
  });
  if (!result.ok) return errorPage(c, ctx, result.error, '/', 400);
  return c.redirect(`/${result.value.owner_login}/${result.value.name}`);
});

web.post('/import-repo', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const url = first(form.url) ?? '';
  const result = await svc.importRepo(c.env, {
    ownerLogin: ctx.user.login,
    sourceUrl: url,
    name: first(form.name) || (url.split('/').pop() ?? ''),
    description: null,
  });
  if (!result.ok) return errorPage(c, ctx, result.error, '/', 400);
  return c.redirect(`/${result.value.owner_login}/${result.value.name}`);
});

// ---------------------------------------------------------------------------
// Token settings: personal access tokens and agent tokens
// ---------------------------------------------------------------------------

function shownOnce(c: Context<App>, ctx: AuthedPageCtx, what: string, token: string, back: string): Response {
  return page(
    c,
    ctx,
    'Token created',
    html`
      <div class="card">
        <div class="flash ok">${what} created. Copy it now: it will not be shown again.</div>
        <pre><code>${token}</code></pre>
        <p><a class="btn" href="${back}">Back</a></p>
      </div>
    `,
    201,
  );
}

web.get('/settings/tokens', async (c) => {
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const owner = c.req.query('owner') || ctx.user.login;
  const ownedOrgs = listOwnedOrgLogins(c.env.DB, ctx.user.id, SETTINGS_ORG_LIMIT);
  const [[pats], listed, orgs] = await Promise.all([
    c.env.DB.batch([
    patListStatement(c.env.DB, ctx.user.id, SETTINGS_PAT_LIMIT),
    ]),
    // An account the user cannot manage only empties the agent section; PATs stay manageable.
    agents.listAgents(c.env, sessionActor(ctx), owner, { limit: SETTINGS_AGENT_LIMIT }),
    ownedOrgs,
  ]);
  const csrf = raw(csrfInput(ctx.session.csrfToken));

  const patRows = ((pats?.results ?? []) as PatListRow[])
    .map(
      (t) => html`
        <div class="repo-row">
          <div>
            <strong>${t.name}</strong>
            <code>${t.prefix}…</code>
            <div class="muted">${parseScopes(t.scopes).join(', ')}</div>
          </div>
          <div class="actions">
            <span class="muted">${t.last_used_at ? timeAgo(t.last_used_at) : 'never used'}</span>
            <form method="post" action="/settings/tokens/${t.id}/delete">
              ${csrf}
              <button class="btn" type="submit">Revoke</button>
            </form>
          </div>
        </div>
      `,
    )
    .join('');
  const scopeBoxes = SCOPES.map(
    (s) => html`<label><input type="checkbox" name="scopes" value="${s}" ${s === 'ci' ? '' : 'checked'} /> ${s}</label>`,
  ).join('');
  const accounts = [ctx.user.login, ...orgs]
    .map((login) =>
      login === owner ? html`<strong>${login}</strong>` : html`<a href="/settings/tokens?owner=${encodeURIComponent(login)}">${login}</a>`,
    )
    .join(' · ');
  const agentRows = (listed.ok ? listed.value.agents : [])
    .map(
      (a) => html`
        <div class="repo-row">
          <div>
            <a href="/settings/agents/${a.id}"><strong>${a.owner_login}/${a.name}</strong></a>
            <span class="badge">${a.revoked_at === null ? 'active' : 'revoked'}</span>
            <div class="muted">${a.description ?? ''}</div>
          </div>
          <div><a class="btn" href="/settings/agents/${a.id}">Tokens</a></div>
        </div>
      `,
    )
    .join('');
  const more = !listed.ok
    ? html`<div class="flash err">${listed.error}</div>`
    : listed.value.nextCursor
      ? html`<p class="muted">More agents exist; use <code>kvarm agents list</code>.</p>`
      : '';
  const admin = ctx.user.is_admin
    ? html`
      <div class="card">
        <h2>Link an account to WorkOS</h2>
        <p class="muted">
          Instance admins only. Gives a PAT-only account (one created by <code>scripts/mint-pat.mjs</code>) a
          WorkOS identity, so that person signs in as that account instead of getting a new one.
        </p>
        <form method="post" action="/settings/link-identity">
          ${csrf}
          <label for="llogin">Login</label>
          <input id="llogin" name="login" type="text" required />
          <label for="lwid">WorkOS user id</label>
          <input id="lwid" name="workosUserId" type="text" required placeholder="user_…" />
          <p><button class="btn" type="submit">Link</button></p>
        </form>
      </div>`
    : '';

  return page(
    c,
    ctx,
    'Access tokens',
    html`
      <div class="card">
        <h2>Personal access tokens</h2>
        <p class="muted">
          Used for git over HTTPS (<code>git clone https://user:PAT@host/owner/repo.git</code>),
          the REST API (<code>Authorization: Bearer PAT</code>), and MCP.
        </p>
        <form method="post" action="/settings/tokens">
          ${csrf}
          <label for="tname">Token name</label>
          <input id="tname" name="name" type="text" required placeholder="laptop, ci-bot…" />
          <label>Scopes</label>
          ${raw(scopeBoxes)}
          <p><button class="btn primary" type="submit">Generate token</button></p>
        </form>
        ${raw(patRows || '<p class="muted">no tokens yet</p>')}
      </div>
      <div class="card">
        <h2>Agent tokens</h2>
        <p class="muted">Account: ${raw(accounts)}</p>
        <p class="muted">
          Agent tokens are minted per agent, scoped to one repository and expire. Create agents with
          <code>kvarm agents create</code> or <code>POST /api/v1/agents</code>.
        </p>
        ${raw(agentRows || (listed.ok ? '<p class="muted">no agents for this account</p>' : ''))}
        ${raw(more)}
      </div>
      ${raw(admin)}
    `,
  );
});

web.post('/settings/tokens', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const scopes = every(form.scopes).filter((s): s is Scope => SCOPES.includes(s as Scope));
  if (scopes.length === 0) return errorPage(c, ctx, 'choose at least one scope', '/settings/tokens', 400);
  const minted = await mintPAT(c.env, ctx.user.id, (first(form.name) || 'token').slice(0, 100), scopes);
  return shownOnce(c, ctx, 'Personal access token', minted.token, '/settings/tokens');
});

web.post('/settings/tokens/:id/delete', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  await revokePAT(c.env, c.req.param('id'), posted.ctx.user.id);
  return c.redirect('/settings/tokens');
});

web.get('/settings/agents/:id', async (c) => {
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const actor = sessionActor(ctx);
  // Both calls check manageability themselves, so they can run together.
  const [agent, tokens] = await Promise.all([
    agents.getAgent(c.env, actor, c.req.param('id')),
    agents.listAgentTokens(c.env, actor, c.req.param('id')),
  ]);
  if (!agent.ok) return errorPage(c, ctx, agent.error, '/settings/tokens', agent.status);
  if (!tokens.ok) return errorPage(c, ctx, tokens.error, '/settings/tokens', tokens.status);
  const a = agent.value;
  const csrf = raw(csrfInput(ctx.session.csrfToken));
  const now = Date.now();
  const rows = tokens.value
    .map((row) => {
      const t = agents.agentTokenJson(row, now);
      const revoke =
        t.status === 'active'
          ? html`<form method="post" action="/settings/agents/${a.id}/tokens/${t.id}/revoke">
              ${csrf}<button class="btn" type="submit">Revoke</button></form>`
          : '';
      return html`
        <div class="repo-row">
          <div>
            <strong>${t.name ?? 'token'}</strong> <code>${t.prefix}…</code>
            <span class="badge">${t.status}</span>
            <div class="muted">${t.repo} · ${t.role}${t.refs.length ? ` · ${t.refs.join(', ')}` : ''} · expires ${t.expiresAt ?? ''}</div>
          </div>
          <div class="actions"><span class="muted">last used ${t.lastUsedAt ?? 'never'}</span> ${raw(revoke)}</div>
        </div>
      `;
    })
    .join('');
  const mintForm =
    a.revoked_at === null
      ? html`
        <form method="post" action="/settings/agents/${a.id}/tokens">
          ${csrf}
          <label for="aname">Token name</label>
          <input id="aname" name="name" type="text" placeholder="optional" />
          <label for="arepo">Repository (owner/name)</label>
          <input id="arepo" name="repo" type="text" required placeholder="${a.owner_login}/project" />
          <label for="arole">Role</label>
          <select id="arole" name="role">
            <option value="read">read</option>
            <option value="write">write</option>
          </select>
          <label for="arefs">Ref patterns (write tokens; separated by spaces or commas)</label>
          <input id="arefs" name="refs" type="text" placeholder="refs/heads/agents/*" />
          <label for="attl">Expires in</label>
          <select id="attl" name="expiresIn">
            <option value="3600">1 hour</option>
            <option value="86400">1 day</option>
            <option value="604800">7 days</option>
            <option value="2592000">30 days</option>
          </select>
          <p><button class="btn primary" type="submit">Mint agent token</button></p>
        </form>`
      : html`<p class="muted">This agent is revoked (${iso(a.revoked_at)}); it cannot receive tokens.</p>`;
  return page(
    c,
    ctx,
    `Agent ${a.name}`,
    html`
      <div class="card">
        <h2>${a.owner_login}/${a.name}</h2>
        <p class="muted">${a.description ?? ''}</p>
        ${raw(mintForm)}
      </div>
      <div class="card">
        <h2>Tokens</h2>
        ${raw(rows || '<p class="muted">no tokens yet</p>')}
      </div>
      <p><a href="/settings/tokens?owner=${encodeURIComponent(a.owner_login)}">back to tokens</a></p>
    `,
  );
});

web.post('/settings/agents/:id/tokens', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const id = c.req.param('id');
  const refs = every(form.refs)
    .flatMap((v) => v.split(/[\s,]+/))
    .filter((r) => r.length > 0);
  const ttl = Number(first(form.expiresIn));
  const minted = await agents.mintAgentToken(c.env, sessionActor(ctx), id, {
    repo: first(form.repo) ?? '',
    role: first(form.role) ?? '',
    refs,
    expiresIn: Number.isFinite(ttl) && first(form.expiresIn) ? ttl : undefined,
    name: first(form.name) || null,
  });
  if (!minted.ok) return errorPage(c, ctx, minted.error, `/settings/agents/${id}`, minted.status);
  return shownOnce(c, ctx, 'Agent token', minted.value.token, `/settings/agents/${id}`);
});

web.post('/settings/agents/:id/tokens/:tokenId/revoke', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx } = posted;
  const id = c.req.param('id');
  const res = await agents.revokeAgentToken(c.env, sessionActor(ctx), id, c.req.param('tokenId'));
  if (!res.ok) return errorPage(c, ctx, res.error, `/settings/agents/${id}`, res.status);
  return c.redirect(`/settings/agents/${id}`);
});

web.post('/settings/link-identity', async (c) => {
  const posted = await requireSessionForm(c);
  if (posted instanceof Response) return posted;
  const { ctx, form } = posted;
  const res = await linkWorkOSIdentity(c.env, sessionActor(ctx), (first(form.login) ?? '').trim(), (first(form.workosUserId) ?? '').trim());
  if (!res.ok) return errorPage(c, ctx, res.error, '/settings/tokens', res.status);
  return page(
    c,
    ctx,
    'Account linked',
    html`<div class="card"><div class="flash ok">${res.value.login} now signs in through WorkOS.</div>
      <p><a class="btn" href="/settings/tokens">Back</a></p></div>`,
  );
});
