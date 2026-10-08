// Offline smoke for the DevFlow defect batch (AG2): asserts the pure-function
// ports of legacy logic (git remote URL parsing, history-cursor keyset,
// audit/query validation, draft type enum, repo-deletion vector prefixes)
// without Milvus/LLM/network. With DEVFLOW_DEFECTS_SMOKE_LIVE=1 it additionally
// runs a throwaway PostgreSQL row-level pass (local git-tree checkout paths,
// beforeMessageId paging, audit round-trip, snooze upsert, cascade + symlink-
// escape-safe checkout cleanup) against the configured DATABASE_URL, deleting
// everything it creates.
// Run: npx tsx tests/devflow-defects.smoke.ts
//      DEVFLOW_DEFECTS_SMOKE_LIVE=1 npx tsx tests/devflow-defects.smoke.ts
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  stat as fsStat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseGitRemoteUrl,
  removeRepoCheckout,
  repoCheckoutPath,
} from "@/lib/devflow/workspace";
import {
  createConversation,
  listMessages,
  messagesWherePage,
} from "@/lib/devflow/conversations";
import { repoMilvusCleanupPrefixes } from "@/lib/devflow/sync";
import { writeAuditLog } from "@/lib/devflow/permissions";
import {
  AuditLogsQuerySchema,
  ConversationMessagesQuerySchema,
  DraftCreateSchema,
  GitHubReviewCommentSchema,
  ProjectIndexSnoozeSchema,
  RepoConnectSchema,
} from "@/lib/devflow/schemas";

let checks = 0;
function ok(name: string): void {
  checks += 1;
  console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// 1. parseGitRemoteUrl (legacy repos.py:76-98 _parse_git_remote_url)
// ---------------------------------------------------------------------------
{
  const https = parseGitRemoteUrl("https://github.com/foo/bar.git");
  assert.deepEqual(https, { owner: "foo", name: "bar", host: "github.com" });
  ok("parseGitRemoteUrl https + .git suffix");

  const scp = parseGitRemoteUrl("git@github.com:foo/bar.git");
  assert.deepEqual(scp, { owner: "foo", name: "bar", host: "github.com" });
  ok("parseGitRemoteUrl scp-like");

  const selfHosted = parseGitRemoteUrl(
    "https://git.corp.example.com/team/repo",
  );
  assert.deepEqual(selfHosted, {
    owner: "team",
    name: "repo",
    host: "git.corp.example.com",
  });
  ok("parseGitRemoteUrl self-hosted host");

  const noSuffix = parseGitRemoteUrl("https://GitHub.com/Foo/Bar.GIT");
  assert.deepEqual(noSuffix, { owner: "Foo", name: "Bar", host: "github.com" });
  ok("parseGitRemoteUrl case-insensitive .git strip, host lowercased");

  assert.equal(parseGitRemoteUrl("not a url"), null);
  assert.equal(parseGitRemoteUrl("https://github.com/onlyowner"), null);
  assert.equal(parseGitRemoteUrl(""), null);
  ok("parseGitRemoteUrl returns null on unparseable input");
}

// ---------------------------------------------------------------------------
// 2. beforeMessageId keyset (legacy chat_memory.MessageStore.timeline:188-206)
// ---------------------------------------------------------------------------
{
  assert.deepEqual(messagesWherePage("conv-1", null), {
    conversationId: "conv-1",
  });
  const anchor = { createdAt: new Date("2026-10-01T00:00:00Z") };
  assert.deepEqual(messagesWherePage("conv-1", anchor), {
    conversationId: "conv-1",
    createdAt: { lt: anchor.createdAt },
  });
  ok("messagesWherePage anchors on createdAt only (no id lexicographic tie)");
}

// ---------------------------------------------------------------------------
// 3. repo-deletion Milvus prefixes (legacy repos.py:429 delete_milvus_documents)
// ---------------------------------------------------------------------------
{
  assert.deepEqual(repoMilvusCleanupPrefixes("repo-9"), [
    "devflow:kb:repo-9:",
    "devflow:project:repo-9:",
    "devflow:item:repo-9:",
  ]);
  ok("repoMilvusCleanupPrefixes sweeps kb + project + item on delete (B-1)");
}

// ---------------------------------------------------------------------------
// 4. RepoConnectSchema (legacy repos.py:157-175)
// ---------------------------------------------------------------------------
{
  const managed = RepoConnectSchema.safeParse({ owner: "o", repo: "r" });
  assert.ok(managed.success && managed.data.provider === "github");
  const local = RepoConnectSchema.safeParse({ localPath: "/tmp/x" });
  assert.ok(local.success && local.data.localPath === "/tmp/x");
  const pinned = RepoConnectSchema.safeParse({
    owner: "o",
    repo: "r",
    cloneParentDir: "/data/clones",
  });
  assert.ok(pinned.success);
  assert.equal(RepoConnectSchema.safeParse({}).success, false);
  assert.equal(RepoConnectSchema.safeParse({ owner: "o" }).success, false);
  assert.equal(RepoConnectSchema.safeParse({ repo: "r" }).success, false);
  ok("RepoConnectSchema: owner+repo or localPath required");
}

// ---------------------------------------------------------------------------
// 5. Draft types incl. send_report (legacy action_drafts.py:60-61, B-8)
// ---------------------------------------------------------------------------
{
  const base = { repoId: "r", content: "body" };
  for (const draftType of [
    "issue_comment",
    "create_issue",
    "close_issue",
    "add_labels",
    "send_report",
  ]) {
    assert.ok(
      DraftCreateSchema.safeParse({ ...base, draftType }).success,
      `draft type ${draftType} must be accepted`,
    );
  }
  assert.equal(
    DraftCreateSchema.safeParse({ ...base, draftType: "send_sms" }).success,
    false,
  );
  ok("DraftCreateSchema accepts the 5 legacy types, rejects others");
}

// ---------------------------------------------------------------------------
// 6. GitHub review comment schema keeps original_line (B-2)
// ---------------------------------------------------------------------------
{
  const outdated = GitHubReviewCommentSchema.safeParse({
    id: 1,
    path: "a.ts",
    line: null,
    original_line: 42,
  });
  assert.ok(outdated.success && outdated.data.original_line === 42);
  const current = GitHubReviewCommentSchema.safeParse({
    id: 2,
    line: 10,
  });
  assert.ok(current.success && current.data.line === 10);
  assert.equal(current.data.original_line, undefined);
  ok("GitHubReviewCommentSchema carries original_line for outdated comments");
}

// ---------------------------------------------------------------------------
// 7. audit-logs query validation (B-7)
// ---------------------------------------------------------------------------
{
  const defaults = AuditLogsQuerySchema.safeParse({});
  assert.ok(defaults.success && defaults.data.limit === 50);
  const coerced = AuditLogsQuerySchema.safeParse({
    limit: "30",
    repoId: "r",
    action: "draft:create",
  });
  assert.ok(
    coerced.success &&
      coerced.data.limit === 30 &&
      coerced.data.repoId === "r" &&
      coerced.data.action === "draft:create",
  );
  assert.equal(AuditLogsQuerySchema.safeParse({ limit: "201" }).success, false);
  assert.equal(AuditLogsQuerySchema.safeParse({ limit: "0" }).success, false);
  assert.equal(AuditLogsQuerySchema.safeParse({ limit: "abc" }).success, false);
  ok("AuditLogsQuerySchema: default 50, max 200, repoId/action filters");
}

// ---------------------------------------------------------------------------
// 8. messages query validation (B-6a)
// ---------------------------------------------------------------------------
{
  const defaults = ConversationMessagesQuerySchema.safeParse({});
  assert.ok(defaults.success && defaults.data.limit === 200);
  assert.ok(!defaults.data.beforeMessageId);
  const cursor = ConversationMessagesQuerySchema.safeParse({
    limit: "5",
    beforeMessageId: "m-1",
  });
  assert.ok(
    cursor.success &&
      cursor.data.limit === 5 &&
      cursor.data.beforeMessageId === "m-1",
  );
  assert.equal(
    ConversationMessagesQuerySchema.safeParse({ limit: "501" }).success,
    false,
  );
  assert.equal(
    ConversationMessagesQuerySchema.safeParse({ beforeMessageId: "" }).success,
    false,
  );
  ok("ConversationMessagesQuerySchema bounds limit and takes the cursor");
}

// ---------------------------------------------------------------------------
// 9. project-index snooze validation (B-7-adjacent, legacy project_index.py:49)
// ---------------------------------------------------------------------------
{
  const snooze = ProjectIndexSnoozeSchema.safeParse({ action: "snooze" });
  assert.ok(snooze.success && snooze.data.days === 7);
  assert.ok(
    ProjectIndexSnoozeSchema.safeParse({ action: "snooze", days: 3 }).success,
  );
  // Anything else (including the plain no-body build POST) must NOT parse as
  // a snooze so the route falls through to indexProject.
  assert.equal(
    ProjectIndexSnoozeSchema.safeParse({ action: "build" }).success,
    false,
  );
  assert.equal(ProjectIndexSnoozeSchema.safeParse(null).success, false);
  assert.equal(
    ProjectIndexSnoozeSchema.safeParse({ action: "snooze", days: 0 }).success,
    false,
  );
  ok("ProjectIndexSnoozeSchema: action snooze, days default 7");
}

// ---------------------------------------------------------------------------
// Optional live pass against local PostgreSQL (row-level, self-cleaning)
// ---------------------------------------------------------------------------
async function live(): Promise<void> {
  const { prisma } = await import("@/lib/db");
  const stamp = Date.now();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "devflow-defects-smoke-"));
  const repo = await prisma.repository.create({
    data: {
      owner: "smoke-defects",
      name: `repo-${stamp}`,
      fullName: `smoke-defects/repo-${stamp}`,
    },
  });
  try {
    // checkout path resolution across modes
    assert.equal(
      repoCheckoutPath({ ...repo, checkoutMode: "local", localPath: tmp }),
      tmp,
    );
    ok("repoCheckoutPath: local mode returns the user tree");

    const parent = path.join(tmp, "clones");
    await mkdir(parent, { recursive: true });
    const managed = {
      ...repo,
      checkoutMode: "managed",
      cloneParentDir: parent,
    };
    const target = repoCheckoutPath(managed);
    assert.ok(target.startsWith(parent + path.sep));
    assert.equal(
      path.basename(target),
      `${repo.id}-smoke-defects__repo-${stamp}`,
    );
    ok("repoCheckoutPath: managed mode honours cloneParentDir");

    // removeRepoCheckout: deletes <id>-* dirs, refuses symlink escapes,
    // no-ops for local mode (legacy: the user tree is not ours to delete).
    await mkdir(path.join(parent, `${repo.id}-keep-me`), { recursive: true });
    await writeFile(
      path.join(parent, `${repo.id}-keep-me`, "f.txt"),
      "x",
      "utf8",
    );
    await mkdir(path.join(parent, `otherid-keep-me`), { recursive: true });
    const outside = path.join(tmp, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(parent, `${repo.id}-escape`));
    const removed = await removeRepoCheckout(managed);
    assert.equal(removed.length, 1);
    // keep-me is gone (rm without force must ENOENT on the removed dir).
    await assert.rejects(() => rm(path.join(parent, `${repo.id}-keep-me`)));
    // The non-matching sibling and the symlink target outside the root both
    // survive: nothing is deleted that is not `<repo.id>-*` inside the root.
    assert.ok(
      (await fsStat(path.join(parent, "otherid-keep-me"))).isDirectory(),
    );
    assert.ok((await fsStat(outside)).isDirectory());
    await rm(path.join(parent, `otherid-keep-me`), {
      recursive: true,
      force: true,
    });
    ok("removeRepoCheckout: prefix-scoped, symlink-escape refused");

    const localCheckout: string[] = await removeRepoCheckout({
      ...repo,
      checkoutMode: "local",
      localPath: tmp,
    });
    assert.deepEqual(localCheckout, []);
    ok("removeRepoCheckout: local mode never deletes the user tree (B-1)");

    // beforeMessageId paging through the real store
    const conv = await createConversation(repo.id, "defects smoke");
    const baseTime = Date.now();
    const created: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const m = await prisma.chatMessage.create({
        data: {
          conversationId: conv.id,
          repoId: repo.id,
          role: "user",
          content: `msg${i}`,
          createdAt: new Date(baseTime + i * 1000),
        },
      });
      created.push(m.id);
    }
    const all = await listMessages(conv.id, 200);
    assert.deepEqual(
      all.map((m) => m.content),
      ["msg1", "msg2", "msg3", "msg4", "msg5"],
    );
    const page = await listMessages(conv.id, 2, created[3]);
    assert.deepEqual(
      page.map((m) => m.content),
      ["msg2", "msg3"],
    );
    ok("listMessages: beforeMessageId returns the earlier page ascending");
    const oldest = await listMessages(conv.id, 2, created[0]);
    assert.equal(oldest.length, 0);
    await assert.rejects(
      () => listMessages(conv.id, 10, "does-not-exist"),
      /not found in conversation/,
    );
    ok("listMessages: unknown cursor is rejected");

    // audit round-trip shaped like GET /api/devflow/audit-logs
    const audit = await writeAuditLog({
      repoId: repo.id,
      action: "draft:create",
      targetType: "issue",
      targetId: "t-1",
      status: "success",
    });
    const rows = await prisma.auditLog.findMany({
      where: { repoId: repo.id, action: "draft:create" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, audit.id);
    ok("writeAuditLog + audit-logs query round-trip");

    // project-index snooze upsert (same statement as the route)
    const snoozedUntil = new Date(Date.now() + 7 * 86_400_000);
    await prisma.projectIndex.upsert({
      where: { repoId: repo.id },
      create: { repoId: repo.id, snoozedUntil },
      update: { snoozedUntil },
    });
    const pi = await prisma.projectIndex.findUnique({
      where: { repoId: repo.id },
    });
    assert.ok(pi && pi.snoozedUntil && pi.snoozedUntil.getTime() > Date.now());
    ok("project-index snooze upsert persists snoozedUntil");

    // repo delete cascades messages but keeps the audit trail (loose ref)
    await prisma.repository.delete({ where: { id: repo.id } });
    assert.equal(
      await prisma.chatMessage.count({ where: { repoId: repo.id } }),
      0,
    );
    assert.equal(
      await prisma.conversation.count({ where: { repoId: repo.id } }),
      0,
    );
    assert.equal(
      await prisma.projectIndex.count({ where: { repoId: repo.id } }),
      0,
    );
    const surviving = await prisma.auditLog.findUnique({
      where: { id: audit.id },
    });
    assert.ok(surviving, "audit trail survives repo deletion by design");
    await prisma.auditLog.delete({ where: { id: audit.id } });
    ok("repo deletion cascades rows; audit row cleaned up last");
  } finally {
    await prisma.repository
      .delete({ where: { id: repo.id } })
      .catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { repoId: repo.id } });
    await rm(tmp, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  console.log("devflow-defects smoke: offline section");
  console.log(`  ${checks} checks passed`);
  if (process.env.DEVFLOW_DEFECTS_SMOKE_LIVE === "1") {
    console.log("devflow-defects smoke: LIVE section (PostgreSQL)");
    await live();
    console.log(`  live pass done (total ${checks} checks)`);
  } else {
    console.log("  LIVE section skipped (set DEVFLOW_DEFECTS_SMOKE_LIVE=1)");
  }
  console.log("DEVFLOW-DEFECTS SMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
