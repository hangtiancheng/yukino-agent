"use client";

// DevFlow workspace context: repository list + the globally selected repo
// (persisted in localStorage), plus typed fetch helpers that unwrap the
// project-wide { message, data } envelope.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RepoSummary } from "@/lib/devflow/types";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export class DevflowApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "DevflowApiError";
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as {
    message?: string;
    data?: T;
  } | null;
  if (!response.ok) {
    throw new DevflowApiError(
      payload?.message || `${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return payload?.data as T;
}

export async function dfGet<T>(path: string): Promise<T> {
  const response = await fetch(`/api/devflow${path}`, { cache: "no-store" });
  return unwrap<T>(response);
}

export async function dfPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/devflow${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return unwrap<T>(response);
}

export async function dfPatch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/devflow${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return unwrap<T>(response);
}

export async function dfDelete<T>(path: string): Promise<T> {
  const response = await fetch(`/api/devflow${path}`, { method: "DELETE" });
  return unwrap<T>(response);
}

export async function dfUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`/api/devflow${path}`, {
    method: "POST",
    body: form,
  });
  return unwrap<T>(response);
}

// ---------------------------------------------------------------------------
// Repository context
// ---------------------------------------------------------------------------

const STORAGE_KEY = "devflow.selectedRepoId";

// Pure reconciliation: pick which repo should be selected given the fresh
// list, the current selection and the persisted one.
function pickRepoId(
  items: RepoSummary[],
  current: string,
  stored: string,
): string {
  if (current && items.some((r) => r.id === current)) return current;
  if (stored && items.some((r) => r.id === stored)) return stored;
  return items[0]?.id ?? "";
}

function readStoredRepoId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

interface DevflowContextValue {
  repos: RepoSummary[];
  reposLoading: boolean;
  repoId: string;
  repo: RepoSummary | null;
  setRepoId: (id: string) => void;
  refreshRepos: () => Promise<void>;
}

const DevflowContext = createContext<DevflowContextValue | null>(null);

export function DevflowProvider({ children }: { children: ReactNode }) {
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

  // Mount-time load. The fetch lives in an inline async IIFE: the
  // react-hooks/set-state-in-effect rule (React Compiler) flags effects that
  // call a tracked setState function, but allows setState inside an inline
  // async closure. refreshRepos (same logic) stays available for event
  // handlers, where calling it is fine.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const items = await dfGet<RepoSummary[]>("/repos");
        if (cancelled) return;
        setRepos(items);
        setRepoIdState((current) =>
          pickRepoId(items, current, readStoredRepoId()),
        );
      } catch {
        if (!cancelled) setRepos([]);
      } finally {
        if (!cancelled) setReposLoading(false);
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
    } catch {
      // localStorage may be unavailable (private mode); selection stays in memory.
    }
  }, []);

  const value = useMemo<DevflowContextValue>(
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
    <DevflowContext.Provider value={value}>{children}</DevflowContext.Provider>
  );
}

export function useDevflow(): DevflowContextValue {
  const context = useContext(DevflowContext);
  if (!context) {
    throw new Error("useDevflow must be used within a DevflowProvider");
  }
  return context;
}
