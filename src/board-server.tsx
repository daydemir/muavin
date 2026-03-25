import { Hono } from "hono";
import { proxy } from "hono/proxy";
import { ackAction, closeAction } from "./blocks";
import {
  clearBoardDataCache,
  getActionItemById,
  getActionsList,
  getBoardOverview,
  getEntityDetailById,
  getEntitiesList,
  warmBoardDataCache,
  type ActionItem,
  type BoardOverview,
  type EntityDetail,
  type EntitySummary,
} from "./board-data";
import {
  flushPendingNoteSyncs,
  getNoteByFilename,
  getNoteRelated,
  getNotesFeed,
  getWorkspaceSelection,
  saveNote,
  startNotesWatcher,
  createNote,
  type EntityRef,
  type NoteFeedItem,
  type NoteRelatedData,
} from "./notes-data";
import { NOTES_DIR } from "./notes";

const HTMX_PATH = `${import.meta.dir}/../assets/board/htmx.min.js`;
const BOARD_CSS_PATH = `${import.meta.dir}/../assets/board/board.css`;
const WORKSPACE_CSS_PATH = `${import.meta.dir}/../assets/workspace/workspace.css`;
const WORKSPACE_JS_PATH = `${import.meta.dir}/../assets/workspace/workspace.js`;
const CODEMIRROR_BUNDLE_PATH = `${import.meta.dir}/../assets/workspace/codemirror-bundle.min.js`;
const ACTION_LIMIT_OPTIONS = [20, 50, 100];
const ENTITY_LIMIT_OPTIONS = [30, 50, 100];
const NOTES_PAGE_SIZE = 50;

type NavSection = "notes" | "actions" | "entities" | "board";

interface LayoutProps {
  current: NavSection;
  title: string;
  heading: string;
  children: unknown;
}

interface ActionCardProps {
  item: ActionItem;
  returnTo: string;
  showActions?: boolean;
  compact?: boolean;
}

interface WorkspacePageProps {
  items: NoteFeedItem[];
  selectedFilename?: string;
  selectedMode?: "list" | "edit" | "focus";
  related?: NoteRelatedData | null;
  nextOffset: number | null;
}

interface TerminalSocketData {
  targetUrl: string;
  protocols: string[];
  upstream?: WebSocket;
  pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
}

let ttydProcess: ReturnType<typeof Bun.spawn> | null = null;
let notesWatcherCleanup: (() => void) | null = null;
let shutdownHooksRegistered = false;

function formatDate(value: string): string {
  return value.slice(0, 10);
}

function formatDateTime(value: string): string {
  return value.slice(0, 19).replace("T", " ");
}

function timeAgoLabel(value: string): string {
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return formatDateTime(value);
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(value);
}

function parseLimit(raw: string | undefined, allowed: number[], fallback: number): number {
  const value = Number(raw ?? "");
  return allowed.includes(value) ? value : fallback;
}

function pagePath(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

function actionRowId(id: string): string {
  return `action-${id}`;
}

function noteRowId(filename: string): string {
  return `note-${filename.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function noteHref(filename: string): string {
  return `/notes/${encodeURIComponent(filename)}`;
}

function noteRelatedHref(filename: string): string {
  return `${noteHref(filename)}/related`;
}

function noteSaveHref(filename: string): string {
  return `${noteHref(filename)}/save`;
}

function actionBadge(item: ActionItem): string {
  return item.actionType ?? "action";
}

function actionStatusLabel(item: ActionItem): string {
  if (item.isDue) return "Due now";
  return item.nextSurfaceAt ? `Deferred until ${formatDate(item.nextSurfaceAt)}` : "Deferred";
}

function notePreview(item: NoteFeedItem): string {
  return item.preview || item.body || "Empty note";
}

const FAVICON_DATA_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%231f2722'/%3E%3Ctext x='50' y='72' text-anchor='middle' font-size='68' font-family='Georgia, serif' fill='%23fffdf7'%3Em%3C/text%3E%3C/svg%3E";

function navLink(current: NavSection, target: NavSection, href: string, label: string) {
  return <a href={href} class={current === target ? "nav-link active" : "nav-link"}>{label}</a>;
}

function actionMutationAttrs(action: "ack" | "done" | "archive", item: ActionItem) {
  return {
    "hx-post": `/actions/${item.id}/${action}`,
    "hx-target": `#${actionRowId(item.id)}`,
    "hx-swap": "outerHTML",
  };
}

function ActionControls(props: { item: ActionItem; returnTo: string }) {
  const { item, returnTo } = props;
  return (
    <div class="action-controls">
      <form method="post" action={`/actions/${item.id}/ack`} {...actionMutationAttrs("ack", item)}>
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit" class="secondary">Ack</button>
      </form>
      <form method="post" action={`/actions/${item.id}/done`} {...actionMutationAttrs("done", item)}>
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit">Done</button>
      </form>
      <form method="post" action={`/actions/${item.id}/archive`} {...actionMutationAttrs("archive", item)}>
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit" class="danger">Archive</button>
      </form>
    </div>
  );
}

function ActionCard(props: ActionCardProps) {
  const { item, returnTo, showActions = true, compact = false } = props;
  return (
    <article id={actionRowId(item.id)} class={compact ? "action-card compact" : "action-card"}>
      <div class="action-meta">
        <span class="date">{formatDate(item.createdAt)}</span>
        <span class="badge">{actionBadge(item)}</span>
        <span class={item.isDue ? "status due" : "status deferred"}>{actionStatusLabel(item)}</span>
      </div>
      <h3>{item.content}</h3>
      <div class="action-links">
        <span class="label">Entities</span>
        {item.entities.length > 0 ? (
          <div class="pill-row">
            {item.entities.map((entity) => <a class="pill" href={`/entity/${entity.id}`}>{entity.name}</a>)}
          </div>
        ) : (
          <span class="muted">none</span>
        )}
      </div>
      {item.sourcePreview ? (
        <div class="action-links">
          <span class="label">Source</span>
          <span class="source-preview">{item.sourcePreview}</span>
        </div>
      ) : null}
      {item.lastAcknowledgedAt ? (
        <div class="acknowledged">Acknowledged {item.lastAcknowledgedAt}</div>
      ) : null}
      {showActions ? <ActionControls item={item} returnTo={returnTo} /> : null}
    </article>
  );
}

function DashboardPage(props: { overview: BoardOverview }) {
  const { overview } = props;
  return (
    <>
      <section class="stats-grid">
        <article class="stat-card"><span class="label">User Blocks</span><strong>{overview.blocks.user}</strong></article>
        <article class="stat-card"><span class="label">Notes</span><strong>{overview.blocks.note}</strong></article>
        <article class="stat-card"><span class="label">Open Actions</span><strong>{overview.blocks.actionOpen}</strong></article>
        <article class="stat-card"><span class="label">Closed Actions</span><strong>{overview.blocks.actionClosed}</strong></article>
        <article class="stat-card"><span class="label">This Week</span><strong>{overview.thisWeek}</strong></article>
        <article class="stat-card"><span class="label">Pending Clarifications</span><strong>{overview.pendingClarifications}</strong></article>
      </section>

      <section class="two-column">
        <article class="panel">
          <h2>Action Stats</h2>
          <dl class="summary-list">
            <div><dt>Total Open</dt><dd>{overview.actionStats.total}</dd></div>
            <div><dt>Due</dt><dd>{overview.actionStats.due}</dd></div>
            <div><dt>Unacknowledged</dt><dd>{overview.actionStats.unacknowledged}</dd></div>
          </dl>
          <div class="type-list">
            {Object.entries(overview.actionStats.byType).length > 0
              ? Object.entries(overview.actionStats.byType).map(([type, count]) => <span class="pill">{type}: {count}</span>)
              : <span class="muted">No typed actions yet</span>}
          </div>
        </article>

        <article class="panel">
          <h2>Top Entities</h2>
          {overview.topEntities.length === 0 ? (
            <p class="muted">No linked entities yet.</p>
          ) : (
            <ul class="entity-list">
              {overview.topEntities.map((entity) => (
                <li>
                  <a href={`/entity/${entity.id}`}>{entity.name}</a>
                  <span class="muted">{entity.linkedBlocks} blocks</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section class="panel">
        <div class="section-header">
          <h2>Top Open Actions</h2>
          <a href="/actions">View all</a>
        </div>
        {overview.topActions.length === 0 ? (
          <p class="muted">No open actions.</p>
        ) : (
          <div class="stack">
            {overview.topActions.map((item) => <ActionCard item={item} returnTo="/board" compact />)}
          </div>
        )}
      </section>
    </>
  );
}

function ActionsPage(props: { items: ActionItem[]; closed: boolean; limit: number; returnTo: string }) {
  const { items, closed, limit, returnTo } = props;
  return (
    <>
      <section class="panel filters">
        <div class="toggle-row">
          <a href={`/actions?limit=${limit}`} class={closed ? "toggle" : "toggle active"}>Open</a>
          <a href={`/actions?closed=1&limit=${limit}`} class={closed ? "toggle active" : "toggle"}>Closed</a>
        </div>
        <form method="get" action="/actions" class="limit-form">
          {closed ? <input type="hidden" name="closed" value="1" /> : null}
          <label>
            Limit
            <select name="limit" value={String(limit)}>
              {ACTION_LIMIT_OPTIONS.map((value) => <option value={String(value)}>{value}</option>)}
            </select>
          </label>
          <button type="submit">Apply</button>
        </form>
      </section>

      <section class="stack">
        {items.length === 0 ? (
          <article class="panel"><p class="muted">No actions found.</p></article>
        ) : items.map((item) => <ActionCard item={item} returnTo={returnTo} showActions={!closed} />)}
      </section>
    </>
  );
}

function EntitiesPage(props: { items: EntitySummary[]; limit: number }) {
  const { items, limit } = props;
  return (
    <>
      <section class="panel filters">
        <form method="get" action="/entities" class="limit-form">
          <label>
            Limit
            <select name="limit" value={String(limit)}>
              {ENTITY_LIMIT_OPTIONS.map((value) => <option value={String(value)}>{value}</option>)}
            </select>
          </label>
          <button type="submit">Apply</button>
        </form>
      </section>

      <section class="panel">
        {items.length === 0 ? (
          <p class="muted">No linked entities found.</p>
        ) : (
          <table class="entities-table">
            <thead>
              <tr><th>Name</th><th>Aliases</th><th>Linked Blocks</th><th>Recent 14d</th></tr>
            </thead>
            <tbody>
              {items.map((entity) => (
                <tr>
                  <td><a href={`/entity/${entity.id}`}>{entity.name}</a></td>
                  <td>{entity.aliasCount}</td>
                  <td>{entity.linkedBlocks}</td>
                  <td>{entity.recentBlocks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function EntityPage(props: { detail: EntityDetail; returnTo: string }) {
  const { detail, returnTo } = props;
  return (
    <>
      <section class="panel entity-header">
        <h1>{detail.name}</h1>
        <div class="pill-row">
          {detail.aliases.length > 0
            ? detail.aliases.map((alias) => <span class="pill muted-pill">{alias}</span>)
            : <span class="muted">No aliases</span>}
        </div>
      </section>

      <section class="panel">
        <h2>Open Actions</h2>
        {detail.openActions.length === 0 ? (
          <p class="muted">No open actions linked to this entity.</p>
        ) : (
          <div class="stack">
            {detail.openActions.map((item) => <ActionCard item={item} returnTo={returnTo} compact />)}
          </div>
        )}
      </section>

      <section class="two-column">
        <article class="panel">
          <h2>Timeline</h2>
          {detail.timeline.length === 0 ? (
            <p class="muted">No timeline entries.</p>
          ) : (
            <ul class="timeline">
              {detail.timeline.map((entry) => (
                <li>
                  <span class="date">{formatDate(entry.createdAt)}</span>
                  <strong>{entry.type === "user_block" ? `user/${entry.source ?? ""}` : `mua/${entry.source ?? ""}/${entry.blockKind ?? "note"}`}</strong>
                  <p>{entry.content}</p>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article class="panel">
          <h2>Related Entities</h2>
          {detail.relatedEntities.length === 0 ? (
            <p class="muted">No related entities.</p>
          ) : (
            <ul class="entity-list">
              {detail.relatedEntities.map((entity) => (
                <li>
                  <a href={`/entity/${entity.id}`}>{entity.name}</a>
                  <span class="muted">{entity.sharedBlocks} shared blocks</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </>
  );
}

function renderTagPills(tags: EntityRef[]) {
  return tags.length > 0
    ? tags.map((tag) => <a class="pill" href={`/entity/${tag.id}`}>{tag.name}</a>)
    : <span class="muted">No tags yet</span>;
}

function EditorToolbar() {
  return (
    <div class="note-toolbar" role="toolbar" aria-label="Markdown tools">
      <button type="button" class="secondary note-tool" data-editor-command="heading" data-editor-value="1">H1</button>
      <button type="button" class="secondary note-tool" data-editor-command="heading" data-editor-value="2">H2</button>
      <button type="button" class="secondary note-tool" data-editor-command="heading" data-editor-value="3">H3</button>
      <button type="button" class="secondary note-tool" data-editor-command="bold">Bold</button>
      <button type="button" class="secondary note-tool" data-editor-command="italic">Italic</button>
      <button type="button" class="secondary note-tool" data-editor-command="bullet">Bullet</button>
      <button type="button" class="secondary note-tool" data-editor-command="quote">Quote</button>
      <button type="button" class="secondary note-tool" data-editor-command="link">Link</button>
      <button type="button" class="secondary note-tool" data-editor-command="code">Code</button>
      <button type="button" class="secondary note-tool" data-editor-command="codeblock">Fence</button>
    </div>
  );
}

function NewNoteCard() {
  return (
    <article
      id="workspace-new-note"
      class="note-card new-note-card"
      data-note-card="true"
      data-note-state="new"
      data-created-at={new Date().toISOString()}
    >
      <div class="note-card-header">
        <div>
          <span class="note-time">New note</span>
          <h2>Untitled</h2>
        </div>
        <button type="button" class="focus-toggle" data-focus-toggle="true">Focus</button>
      </div>
      <div class="note-preview-shell">
        <p class="note-preview">Press Enter and start typing.</p>
      </div>
      <div class="note-edit-shell">
        <EditorToolbar />
        <div class="note-edit-host"></div>
        <div class="note-edit-actions">
          <button type="button" data-save-note="true">Save</button>
          <button type="button" class="secondary" data-exit-edit="true">Done</button>
          <button type="button" class="secondary" data-focus-toggle="true">Focus</button>
          <span class="note-save-status" aria-live="polite"></span>
        </div>
      </div>
      <textarea class="note-body-source" hidden></textarea>
    </article>
  );
}

function NoteCard(props: { item: NoteFeedItem; selected?: boolean }) {
  const { item, selected = false } = props;
  return (
    <article
      id={noteRowId(item.filename)}
      class={selected ? "note-card selected" : "note-card"}
      data-note-card="true"
      data-filename={item.filename}
      data-note-state="saved"
      data-created-at={item.createdAt}
      data-note-url={noteHref(item.filename)}
      data-related-url={noteRelatedHref(item.filename)}
      data-save-url={noteSaveHref(item.filename)}
    >
      <div class="note-card-header">
        <div>
          <span class="note-time">{timeAgoLabel(item.createdAt)}</span>
          <h2>{item.title}</h2>
        </div>
        <button type="button" class="focus-toggle" data-focus-toggle="true">Focus</button>
      </div>
      <div class="note-meta-row">
        <div class="pill-row">{renderTagPills(item.tags)}</div>
        {!item.isSynced ? <span class="sync-pill warning">Pending sync</span> : <span class="sync-pill">Synced</span>}
      </div>
      <div class="note-preview-shell">
        <p class="note-preview">{notePreview(item)}</p>
        {item.syncError ? <p class="note-error">Sync error: {item.syncError}</p> : null}
      </div>
      <div class="note-edit-shell">
        <EditorToolbar />
        <div class="note-edit-host"></div>
        <div class="note-edit-actions">
          <button type="button" data-save-note="true">Save</button>
          <button type="button" class="secondary" data-exit-edit="true">Done</button>
          <button type="button" class="secondary" data-focus-toggle="true">Focus</button>
          <a class="secondary-link" href={noteHref(item.filename)}>Open</a>
          <span class="note-save-status" aria-live="polite"></span>
        </div>
      </div>
      <textarea class="note-body-source" hidden>{item.body}</textarea>
    </article>
  );
}

function FeedMore(props: { nextOffset: number | null }) {
  if (props.nextOffset === null) return <div id="notes-feed-more"></div>;
  return (
    <div id="notes-feed-more" class="feed-more">
      <button
        type="button"
        class="secondary"
        hx-get={`/notes/feed?offset=${props.nextOffset}&limit=${NOTES_PAGE_SIZE}`}
        hx-target="#notes-feed-more"
        hx-swap="outerHTML"
      >
        Load more
      </button>
    </div>
  );
}

function RelatedPanel(props: { related?: NoteRelatedData | null }) {
  const { related } = props;
  if (!related) {
    return (
      <div class="related-shell">
        <section class="sidebar-panel">
          <h2>Related Blocks</h2>
          <p class="muted">Select a note to load related blocks.</p>
        </section>
      </div>
    );
  }

  const renderBlockList = (title: string, rows: NoteRelatedData["userBlocks"]) => (
    <section class="sidebar-panel">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p class="muted">None yet.</p>
      ) : (
        <div class="related-list">
          {rows.map((row) => (
            <article class="related-card">
              <div class="related-meta">
                <span class={row.authorType === "user" ? "pill muted-pill" : "pill"}>{row.authorType}</span>
                <span>{formatDate(row.createdAt)}</span>
              </div>
              <p>{row.content}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div class="related-shell">
      {renderBlockList("User Blocks", related.userBlocks)}
      {renderBlockList("Mua Blocks", related.muaBlocks)}
      <section class="sidebar-panel">
        <h2>Entities</h2>
        {related.entities.length === 0 ? (
          <p class="muted">No linked entities.</p>
        ) : (
          <div class="pill-row">
            {related.entities.map((entity) => <a class="pill" href={`/entity/${entity.id}`}>{entity.name}</a>)}
          </div>
        )}
      </section>
    </div>
  );
}

function WorkspacePage(props: WorkspacePageProps) {
  const { items, selectedFilename, selectedMode = "list", related, nextOffset } = props;
  return (
    <div
      class="workspace-page"
      id="workspace-page"
      data-selected-filename={selectedFilename ?? ""}
      data-selected-mode={selectedMode}
    >
      <section class="workspace-main">
        <div class="workspace-feed-panel">
          <div id="notes-feed" class="note-feed">
            <NewNoteCard />
            {items.map((item) => <NoteCard item={item} selected={item.filename === selectedFilename} />)}
          </div>
          <FeedMore nextOffset={nextOffset} />
        </div>

        <aside class="workspace-sidebar" id="workspace-sidebar" data-view="related">
          <div class="sidebar-tab-row">
            <button type="button" class="sidebar-tab" data-sidebar-view="both">Both</button>
            <button type="button" class="sidebar-tab active" data-sidebar-view="related">Related</button>
            <button type="button" class="sidebar-tab" data-sidebar-view="terminal">Terminal</button>
          </div>
          <div class="sidebar-content">
            <div class="related-panel-shell">
              <div id="related-loading" class="related-loading htmx-indicator">Loading related blocks…</div>
              <div id="related-panel" class="related-panel" hx-indicator="#related-loading">
                <RelatedPanel related={related} />
              </div>
            </div>
            <div id="terminal-panel" class="terminal-panel">
              <iframe title="Muavin Live" data-src="/terminal/" loading="lazy" class="terminal-frame"></iframe>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}

function Layout(props: LayoutProps) {
  const { current, title, heading, children } = props;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="color-scheme" content="light dark" />
        <link rel="icon" href={FAVICON_DATA_URL} />
        <link rel="stylesheet" href="/static/board.css" />
        <link rel="stylesheet" href="/static/workspace/workspace.css" />
        <script src="/static/htmx.min.js" defer />
        <script type="module" src="/static/workspace/workspace.js"></script>
      </head>
      <body>
        <header class="site-header">
          <div>
            <p class="eyebrow">Muavin</p>
            <h1>{heading}</h1>
          </div>
          <div class="header-actions">
            <nav>
              {navLink(current, "notes", "/", "Notes")}
              {navLink(current, "actions", "/actions", "Actions")}
              {navLink(current, "entities", "/entities", "Entities")}
            </nav>
            <button type="button" class="theme-toggle" data-theme-toggle>
              <span class="theme-toggle-label" data-theme-label>Dark mode</span>
            </button>
          </div>
        </header>
        <main class={current === "notes" ? "page-shell workspace-shell" : "page-shell"}>{children}</main>
      </body>
    </html>
  );
}

async function serveStatic(c: any, path: string, contentType: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) return c.notFound();
  return c.body(await file.arrayBuffer(), 200, { "content-type": contentType });
}

function redirectTarget(c: any, fallback: string): string {
  const bodyValue = c.get("returnTo");
  if (typeof bodyValue === "string" && bodyValue) return bodyValue;
  const referer = c.req.header("referer");
  return referer || fallback;
}

function isHtmxRequest(c: any): boolean {
  return c.req.header("HX-Request") === "true";
}

function wantsJson(c: any): boolean {
  const accept = c.req.header("accept") ?? "";
  return accept.includes("application/json");
}

async function captureReturnTo(c: any): Promise<void> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded") && !contentType.includes("multipart/form-data")) return;
  const form = await c.req.formData();
  const returnTo = form.get("returnTo");
  if (typeof returnTo === "string" && returnTo) c.set("returnTo", returnTo);
}

async function readNoteBody(c: any): Promise<string> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await c.req.json().catch(() => ({}));
    return typeof json.content === "string" ? json.content : "";
  }
  const form = await c.req.formData();
  const content = form.get("content");
  return typeof content === "string" ? content : "";
}

async function renderUpdatedAction(c: any, actionId: string): Promise<Response> {
  const item = await getActionItemById(actionId);
  if (!item) return c.html("", 200);
  const returnTo = redirectTarget(c, "/actions");
  return c.html(<ActionCard item={item} returnTo={returnTo} compact={!returnTo.startsWith("/actions")} />);
}

async function buildWorkspaceModel(input?: {
  selectedFilename?: string;
  selectedMode?: "list" | "edit" | "focus";
}) {
  const feed = await getNotesFeed({ offset: 0, limit: NOTES_PAGE_SIZE });
  let items = feed.items;
  let related: NoteRelatedData | null = null;

  if (input?.selectedFilename) {
    const selected = await getWorkspaceSelection(input.selectedFilename);
    if (selected && !items.some((item) => item.filename === selected.filename)) {
      items = [selected, ...items].slice(0, NOTES_PAGE_SIZE);
    }
    related = await getNoteRelated(input.selectedFilename);
  }

  return {
    items,
    related,
    nextOffset: feed.nextOffset,
  };
}

function buildTerminalProxyUrl(terminalPort: number, reqUrl: string): string {
  const url = new URL(reqUrl);
  const path = url.pathname.replace(/^\/terminal/, "") || "/";
  return `http://127.0.0.1:${terminalPort}${path}${url.search}`;
}

function buildTerminalSocketUrl(terminalPort: number, reqUrl: string): string {
  const url = new URL(reqUrl);
  const path = url.pathname.replace(/^\/terminal/, "") || "/";
  return `ws://127.0.0.1:${terminalPort}${path}${url.search}`;
}

async function ensureTtydInstalled(): Promise<void> {
  const proc = Bun.spawn(["/bin/zsh", "-lc", "command -v ttyd"], { stdout: "pipe", stderr: "pipe" });
  const path = (await new Response(proc.stdout).text()).trim();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("ttyd is required for `bun muavin serve`. Install it with `brew install ttyd`.");
  }
  if (!path) {
    throw new Error("ttyd was found but its path could not be resolved.");
  }
  process.env.MUAVIN_TTYD_PATH = path;
}

async function startTtyd(port: number): Promise<void> {
  if (ttydProcess) return;
  await ensureTtydInstalled();
  const ttydPath = process.env.MUAVIN_TTYD_PATH ?? "ttyd";
  const terminalPort = port + 1;
  console.log(`[workspace] starting ttyd on http://127.0.0.1:${terminalPort} using ${ttydPath}`);
  ttydProcess = Bun.spawn(
    [ttydPath, "-W", "-p", String(terminalPort), "bun", "run", `${import.meta.dir}/cli.ts`, "live", "--cwd", NOTES_DIR],
    {
      cwd: NOTES_DIR,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    },
  );
  console.log(`[workspace] ttyd child pid=${ttydProcess.pid ?? "unknown"}`);
  await Bun.sleep(250);
  const exited = await Promise.race([
    ttydProcess.exited.then((code) => code),
    Bun.sleep(1).then(() => null as number | null),
  ]);
  if (exited !== null) {
    ttydProcess = null;
    throw new Error(`ttyd exited immediately with code ${exited}`);
  }
}

async function shutdownWorkspaceRuntime(): Promise<void> {
  notesWatcherCleanup?.();
  notesWatcherCleanup = null;
  if (ttydProcess) {
    try {
      ttydProcess.kill();
    } catch {}
    ttydProcess = null;
  }
}

function registerShutdownHooks() {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;
  const shutdown = () => {
    void shutdownWorkspaceRuntime().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => {
    notesWatcherCleanup?.();
    try {
      ttydProcess?.kill();
    } catch {}
  });
}

function createApp(terminalPort: number) {
  const app = new Hono();

  app.get("/static/htmx.min.js", (c) => serveStatic(c, HTMX_PATH, "application/javascript; charset=utf-8"));
  app.get("/static/board.css", (c) => serveStatic(c, BOARD_CSS_PATH, "text/css; charset=utf-8"));
  app.get("/static/workspace/workspace.css", (c) => serveStatic(c, WORKSPACE_CSS_PATH, "text/css; charset=utf-8"));
  app.get("/static/workspace/workspace.js", (c) => serveStatic(c, WORKSPACE_JS_PATH, "application/javascript; charset=utf-8"));
  app.get("/static/workspace/codemirror-bundle.min.js", (c) => serveStatic(c, CODEMIRROR_BUNDLE_PATH, "application/javascript; charset=utf-8"));

  app.get("/", async (c) => {
    const model = await buildWorkspaceModel();
    return c.html(
      <Layout title="Muavin Workspace" heading="Workspace" current="notes">
        <WorkspacePage items={model.items} related={null} nextOffset={model.nextOffset} />
      </Layout>,
    );
  });

  app.get("/board", async (c) => {
    const overview = await getBoardOverview();
    return c.html(
      <Layout title="Muavin Board" heading="Board" current="board">
        <DashboardPage overview={overview} />
      </Layout>,
    );
  });

  app.get("/notes/feed", async (c) => {
    const offset = Math.max(0, Number(c.req.query("offset") ?? "0"));
    const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? `${NOTES_PAGE_SIZE}`), 100));
    const feed = await getNotesFeed({ offset, limit });
    return c.html(
      <>
        {feed.items.map((item) => <NoteCard item={item} />)}
        <FeedMore nextOffset={feed.nextOffset} />
      </>,
    );
  });

  app.get("/notes/:filename", async (c) => {
    const filename = decodeURIComponent(c.req.param("filename"));
    const note = await getNoteByFilename(filename);
    if (!note) {
      return c.html(
        <Layout title="Note not found" heading="Workspace" current="notes">
          <article class="panel"><p>Note not found.</p></article>
        </Layout>,
        404,
      );
    }
    const model = await buildWorkspaceModel({ selectedFilename: filename, selectedMode: "focus" });
    return c.html(
      <Layout title={filename} heading="Workspace" current="notes">
        <WorkspacePage
          items={model.items}
          selectedFilename={filename}
          selectedMode="focus"
          related={model.related}
          nextOffset={model.nextOffset}
        />
      </Layout>,
    );
  });

  app.get("/notes/:filename/related", async (c) => {
    const filename = decodeURIComponent(c.req.param("filename"));
    const related = await getNoteRelated(filename);
    return c.html(<RelatedPanel related={related} />);
  });

  app.post("/notes/new", async (c) => {
    const content = await readNoteBody(c);
    const item = await createNote({ content });
    if (wantsJson(c)) return c.json(item);
    return c.redirect(noteHref(item.filename), 303);
  });

  app.post("/notes/:filename/save", async (c) => {
    const filename = decodeURIComponent(c.req.param("filename"));
    const content = await readNoteBody(c);
    const item = await saveNote({ filename, content });
    if (wantsJson(c)) return c.json(item);
    return c.redirect(noteHref(item.filename), 303);
  });

  app.get("/actions", async (c) => {
    const closed = c.req.query("closed") === "1";
    const limit = parseLimit(c.req.query("limit"), ACTION_LIMIT_OPTIONS, 20);
    const items = await getActionsList({ closed, limit });
    const returnTo = pagePath("/actions", c.req.url.includes("?") ? new URL(c.req.url).search : "");
    return c.html(
      <Layout title={closed ? "Closed Actions" : "Open Actions"} heading="Actions" current="actions">
        <ActionsPage items={items} closed={closed} limit={limit} returnTo={returnTo} />
      </Layout>,
    );
  });

  app.get("/entities", async (c) => {
    const limit = parseLimit(c.req.query("limit"), ENTITY_LIMIT_OPTIONS, 30);
    const items = await getEntitiesList({ limit });
    return c.html(
      <Layout title="Entities" heading="Entities" current="entities">
        <EntitiesPage items={items} limit={limit} />
      </Layout>,
    );
  });

  app.get("/entity/:id", async (c) => {
    const id = c.req.param("id");
    const detail = await getEntityDetailById(id, { limit: 30 });
    if (!detail) {
      return c.html(
        <Layout title="Not Found" heading="Entities" current="entities">
          <article class="panel"><p>Entity not found.</p></article>
        </Layout>,
        404,
      );
    }
    return c.html(
      <Layout title={detail.name} heading="Entities" current="entities">
        <EntityPage detail={detail} returnTo={`/entity/${detail.id}`} />
      </Layout>,
    );
  });

  app.post("/actions/:id/ack", async (c) => {
    await captureReturnTo(c);
    const id = c.req.param("id");
    await ackAction(id);
    clearBoardDataCache();
    if (isHtmxRequest(c)) return renderUpdatedAction(c, id);
    return c.redirect(redirectTarget(c, "/actions"));
  });

  app.post("/actions/:id/done", async (c) => {
    await captureReturnTo(c);
    await closeAction(c.req.param("id"), { closedReason: "done" });
    clearBoardDataCache();
    if (isHtmxRequest(c)) return c.html("", 200);
    return c.redirect(redirectTarget(c, "/actions"));
  });

  app.post("/actions/:id/archive", async (c) => {
    await captureReturnTo(c);
    await closeAction(c.req.param("id"), { closedReason: "archived" });
    clearBoardDataCache();
    if (isHtmxRequest(c)) return c.html("", 200);
    return c.redirect(redirectTarget(c, "/actions"));
  });

  app.all("/terminal", (c) => proxy(buildTerminalProxyUrl(terminalPort, `${c.req.url}/`), { raw: c.req.raw }));
  app.all("/terminal/*", (c) => proxy(buildTerminalProxyUrl(terminalPort, c.req.url), { raw: c.req.raw }));

  return app;
}

export async function startWorkspaceServer(port: number) {
  await flushPendingNoteSyncs();
  notesWatcherCleanup = await startNotesWatcher();
  registerShutdownHooks();

  const terminalPort = port + 1;
  const app = createApp(terminalPort);
  let server: ReturnType<typeof Bun.serve<TerminalSocketData>>;

  try {
    await startTtyd(port);
    await warmBoardDataCache();

    console.log(`Muavin running on http://127.0.0.1:${port}`);
    console.log(`To access from other Tailscale devices: tailscale serve ${port}`);

    server = Bun.serve<TerminalSocketData>({
      port,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/terminal") && req.headers.get("upgrade") === "websocket") {
          const upgraded = server.upgrade(req, {
            data: {
              targetUrl: buildTerminalSocketUrl(terminalPort, req.url),
              protocols: (req.headers.get("sec-websocket-protocol") ?? "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
              pendingMessages: [],
            },
          });
          if (upgraded) return;
          return new Response("terminal websocket upgrade failed", { status: 502 });
        }
        return app.fetch(req);
      },
      websocket: {
        open(ws) {
          const upstream = ws.data.protocols.length > 0
            ? new WebSocket(ws.data.targetUrl, ws.data.protocols)
            : new WebSocket(ws.data.targetUrl);
          upstream.binaryType = "arraybuffer";
          ws.data.upstream = upstream;
          upstream.onopen = () => {
            const pending = ws.data.pendingMessages.splice(0, ws.data.pendingMessages.length);
            for (const message of pending) {
              upstream.send(message);
            }
          };
          upstream.onmessage = (event) => {
            try {
              ws.send(event.data as string | ArrayBuffer | Uint8Array);
            } catch {}
          };
          upstream.onerror = () => {
            ws.data.pendingMessages.length = 0;
            try {
              ws.close(1011, "terminal upstream error");
            } catch {}
          };
          upstream.onclose = (event) => {
            ws.data.pendingMessages.length = 0;
            try {
              ws.close(event.code || 1000, event.reason);
            } catch {}
          };
        },
        message(ws, message) {
          if (ws.data.upstream?.readyState === WebSocket.OPEN) {
            ws.data.upstream.send(message as string | ArrayBuffer | Uint8Array);
            return;
          }
          ws.data.pendingMessages.push(message as string | ArrayBuffer | Uint8Array);
        },
        close(ws) {
          ws.data.pendingMessages.length = 0;
          try {
            ws.data.upstream?.close();
          } catch {}
        },
      },
    });
  } catch (error) {
    await shutdownWorkspaceRuntime();
    throw error;
  }

  return server;
}
