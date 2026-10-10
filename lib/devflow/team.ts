import { z } from "zod/v4";
import { prisma } from "@/lib/db";

export const TeamMemberCreateSchema = z.object({
  githubLogin: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/),
  displayName: z.string().max(100).optional(),
  skills: z.array(z.string().min(1).max(60)).max(30).default([]),
  availability: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
});
export type TeamMemberCreate = z.infer<typeof TeamMemberCreateSchema>;

export const TeamMemberUpdateSchema = z
  .object({
    displayName: z.string().max(100).nullable().optional(),
    skills: z.array(z.string().min(1).max(60)).max(30).optional(),
    availability: z.string().max(100).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (v) =>
      v.displayName !== undefined ||
      v.skills !== undefined ||
      v.availability !== undefined ||
      v.notes !== undefined,
    { message: "At least one field must be provided" },
  );
export type TeamMemberUpdate = z.infer<typeof TeamMemberUpdateSchema>;

export interface TeamMemberRow {
  id: string;
  repoId: string;
  githubLogin: string;
  displayName: string | null;
  skills: string[];
  availability: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMemberProfile {
  name: string;
  displayName: string;
  skills: string[];
  availability: string;
  notes: string;
}

export function toTeamMemberProfile(
  member: Pick<
    TeamMemberRow,
    "githubLogin" | "displayName" | "skills" | "availability" | "notes"
  >,
): TeamMemberProfile {
  return {
    name: member.githubLogin,
    displayName: member.displayName ?? "",
    skills: member.skills,
    availability: member.availability ?? "",
    notes: member.notes ?? "",
  };
}

export function teamMemberView(member: TeamMemberRow) {
  return {
    id: member.id,
    repoId: member.repoId,
    githubLogin: member.githubLogin,
    displayName: member.displayName,
    skills: member.skills,
    availability: member.availability,
    notes: member.notes,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

export type TeamMemberMutationResult<T> =
  { ok: true; member: T } | { ok: false; error: "duplicate" | "notFound" };

export async function listTeamMembers(
  repoId: string,
): Promise<TeamMemberRow[]> {
  return prisma.teamMember.findMany({
    where: { repoId },
    orderBy: { githubLogin: "asc" },
  });
}

export async function listTeamMemberLogins(repoId: string): Promise<string[]> {
  const rows = await prisma.teamMember.findMany({
    where: { repoId },
    select: { githubLogin: true },
  });
  return rows.map((row) => row.githubLogin);
}

export async function createTeamMember(
  repoId: string,
  input: TeamMemberCreate,
): Promise<TeamMemberMutationResult<TeamMemberRow>> {
  const existing = await prisma.teamMember.findUnique({
    where: { repoId_githubLogin: { repoId, githubLogin: input.githubLogin } },
  });
  if (existing) return { ok: false, error: "duplicate" };
  const member = await prisma.teamMember.create({
    data: {
      repoId,
      githubLogin: input.githubLogin,
      displayName: input.displayName ?? null,
      skills: input.skills,
      availability: input.availability ?? null,
      notes: input.notes ?? null,
    },
  });
  return { ok: true, member };
}

export async function updateTeamMember(
  repoId: string,
  memberId: string,
  input: TeamMemberUpdate,
): Promise<TeamMemberMutationResult<TeamMemberRow>> {
  const existing = await prisma.teamMember.findUnique({
    where: { id: memberId },
  });
  if (!existing || existing.repoId !== repoId) {
    return { ok: false, error: "notFound" };
  }
  const member = await prisma.teamMember.update({
    where: { id: memberId },
    data: {
      ...(input.displayName !== undefined
        ? { displayName: input.displayName }
        : {}),
      ...(input.skills !== undefined ? { skills: input.skills } : {}),
      ...(input.availability !== undefined
        ? { availability: input.availability }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
  return { ok: true, member };
}

export async function deleteTeamMember(
  repoId: string,
  memberId: string,
): Promise<TeamMemberMutationResult<TeamMemberRow>> {
  const existing = await prisma.teamMember.findUnique({
    where: { id: memberId },
  });
  if (!existing || existing.repoId !== repoId) {
    return { ok: false, error: "notFound" };
  }
  const member = await prisma.teamMember.delete({ where: { id: memberId } });
  return { ok: true, member };
}
