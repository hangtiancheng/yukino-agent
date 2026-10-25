"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { RepoSummary } from "@/lib/dev-flow/types";

export class DevFlowApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "DevFlowApiError";
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as {
    message?: string;
    data?: T;
  } | null;
  if (!response.ok) {
    throw new DevFlowApiError(
      payload?.message || `${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return payload?.data as T;
}

export async function dfGet<T>(path: string): Promise<T> {
  const response = await fetch(`/api/dev-flow${path}`, { cache: "no-store" });
  return unwrap<T>(response);
}

export async function dfPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/dev-flow${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return unwrap<T>(response);
}

export async function dfPatch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/dev-flow${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return unwrap<T>(response);
}

export async function dfDelete<T>(path: string): Promise<T> {
  const response = await fetch(`/api/dev-flow${path}`, { method: "DELETE" });
  return unwrap<T>(response);
}

export async function dfUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`/api/dev-flow${path}`, {
    method: "POST",
    body: form,
  });
  return unwrap<T>(response);
}

const STORAGE_KEY = "devFlow.selectedRepoId";

function pickRepoId(
  items: RepoSummary[],
  current: string,
  stored: string,
): string {
  if (current && items.some((r) => r.id === current)) {
    return current;
  }
  if (stored && items.some((r) => r.id === stored)) {
    return stored;
  }
  return items[0]?.id ?? "";
}

function readStoredRepoId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

interface DevFlowContextValue {
  repos: RepoSummary[];
  reposLoading: boolean;
  repoId: string;
  repo: RepoSummary | null;
  setRepoId: (id: string) => void;
  refreshRepos: () => Promise<void>;
}

const DevFlowContext = createContext<DevFlowContextValue | null>(null);

export function DevFlowProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [repoId, setRepoIdState] = useState("");

  const refreshRepos = useCallback(async () => {
    try {
      const items = await dfGet<RepoSummary[]>("/repos");
      setRepos(items);
      setRepoIdState((current) =>
        pickRepoId(items, current, readStoredRepoId()),
      );
    } catch {
      setRepos([]);
    } finally {
      setReposLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await dfGet<RepoSummary[]>("/repos");
        if (cancelled) {
          return;
        }
        setRepos(items);
        setRepoIdState((current) =>
          pickRepoId(items, current, readStoredRepoId()),
        );
      } catch {
        if (!cancelled) {
          setRepos([]);
        }
      } finally {
        if (!cancelled) {
          setReposLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setRepoId = useCallback((id: string) => {
    setRepoIdState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {}
  }, []);

  const value = useMemo<DevFlowContextValue>(
    () => ({
      repos,
      reposLoading,
      repoId,
      repo: repos.find((r) => r.id === repoId) ?? null,
      setRepoId,
      refreshRepos,
    }),
    [repos, reposLoading, repoId, setRepoId, refreshRepos],
  );

  return (
    <DevFlowContext.Provider value={value}>{children}</DevFlowContext.Provider>
  );
}

export function useDevFlow(): DevFlowContextValue {
  const context = useContext(DevFlowContext);
  if (!context) {
    throw new Error("useDevFlow must be used within a DevFlowProvider");
  }
  return context;
}
