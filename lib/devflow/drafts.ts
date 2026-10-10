import { prisma } from "@/lib/db";
import { decryptToken } from "./crypto";
import {
  addIssueLabels,
  closeIssue,
  createIssue,
  createIssueComment,
  type GitHubContext,
} from "./github";

export type DraftStatus =
  "pending_confirmation" | "executed" | "rejected" | "failed";

async function repoContextFor(repoId: string): Promise<{
  owner: string;
  name: string;
  ctx: GitHubContext;
}> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) throw new Error(`Repository ${repoId} not found`);
  return {
    owner: repo.owner,
    name: repo.name,
    ctx: {
      token: decryptToken(repo.tokenEncrypted),
      baseUrl: repo.apiBaseUrl,
    },
  };
}

export async function executeDraft(draftId: string) {
  const draft = await prisma.actionDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new Error(`Action draft ${draftId} not found`);
  if (draft.status !== "pending_confirmation") {
    throw new Error(`Draft is already ${draft.status}`);
  }

  const { owner, name, ctx } = await repoContextFor(draft.repoId);
  try {
    let executionResult: unknown;
    switch (draft.draftType) {
      case "issue_comment": {
        if (!draft.targetNumber)
          throw new Error("issue_comment drafts require targetNumber");
        executionResult = await createIssueComment(
          owner,
          name,
          draft.targetNumber,
          draft.content ?? "",
          ctx,
        );
        break;
      }
      case "create_issue": {
        executionResult = await createIssue(
          owner,
          name,
          draft.title,
          draft.content ?? "",
          ctx,
        );
        break;
      }
      case "close_issue": {
        if (!draft.targetNumber)
          throw new Error("close_issue drafts require targetNumber");
        executionResult = await closeIssue(
          owner,
          name,
          draft.targetNumber,
          ctx,
        );
        break;
      }
      case "add_labels": {
        if (!draft.targetNumber)
          throw new Error("add_labels drafts require targetNumber");
        if (draft.labels.length === 0)
          throw new Error("add_labels drafts require labels");
        executionResult = await addIssueLabels(
          owner,
          name,
          draft.targetNumber,
          draft.labels,
          ctx,
        );
        break;
      }
      case "send_report": {
        executionResult = {
          status: "recorded",
          message:
            "Report draft marked as sent in DevFlow; no external messaging channel is configured.",
        };
        break;
      }
      default:
        throw new Error(`Unknown draft type: ${draft.draftType}`);
    }

    return prisma.actionDraft.update({
      where: { id: draftId },
      data: {
        status: "executed",
        executionResult: summarizeResult(executionResult),
        errorMessage: null,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return prisma.actionDraft.update({
      where: { id: draftId },
      data: { status: "failed", errorMessage: message },
    });
  }
}

function summarizeResult(result: unknown): object {
  if (!result || typeof result !== "object") return { raw: String(result) };
  const r = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["id", "number", "html_url", "state", "title"]) {
    if (r[key] !== undefined) summary[key] = r[key];
  }
  return summary;
}

export async function rejectDraft(draftId: string) {
  const draft = await prisma.actionDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new Error(`Action draft ${draftId} not found`);
  if (draft.status !== "pending_confirmation") {
    throw new Error(`Draft is already ${draft.status}`);
  }
  return prisma.actionDraft.update({
    where: { id: draftId },
    data: { status: "rejected" },
  });
}
