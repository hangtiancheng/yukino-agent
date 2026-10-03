"use client";

// DevFlow workspace shell: sidebar navigation + top bar with the global
// repository picker, theme toggle and a link back to the main assistant.
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  CircleDot,
  ClipboardCheck,
  Code2,
  FileText,
  FolderGit2,
  GitBranch,
  LayoutDashboard,
  MessageSquareText,
  Moon,
  GitPullRequest,
  Sparkles,
  Sun,
  ThumbsUp,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useTheme } from "@/components/theme-provider";
import { useDevflow } from "./provider";

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ href: string; label: string; icon: typeof Activity }>;
}> = [
  {
    label: "Overview",
    items: [{ href: "/devflow", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Delivery",
    items: [
      { href: "/devflow/issues", label: "Issues", icon: CircleDot },
      { href: "/devflow/pulls", label: "Pull Requests", icon: GitPullRequest },
      { href: "/devflow/ci", label: "CI / Actions", icon: Activity },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/devflow/knowledge", label: "Knowledge Base", icon: BookOpen },
      { href: "/devflow/code", label: "Code", icon: Code2 },
      { href: "/devflow/chat", label: "Agent Chat", icon: MessageSquareText },
      { href: "/devflow/reports", label: "Weekly Reports", icon: FileText },
      { href: "/devflow/feedback", label: "Feedback", icon: ThumbsUp },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/devflow/drafts", label: "Action Drafts", icon: ClipboardCheck },
      { href: "/devflow/repos", label: "Repositories", icon: FolderGit2 },
    ],
  },
];

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

function RepoPicker() {
  const { repos, reposLoading, repoId, setRepoId } = useDevflow();
  if (reposLoading) {
    return <Skeleton className="h-8 w-52" />;
  }
  if (repos.length === 0) {
    return (
      <Link href="/devflow/repos">
        <Button variant="outline" size="sm">
          <GitBranch className="size-3.5" />
          Connect a repository
        </Button>
      </Link>
    );
  }
  return (
    <Select
      value={repoId || undefined}
      onValueChange={(value) => {
        if (value) setRepoId(value);
      }}
    >
      <SelectTrigger className="w-56" aria-label="Select repository">
        <GitBranch className="text-muted-foreground size-3.5" />
        <SelectValue placeholder="Select repository">
          {(value: string | null) =>
            repos.find((r) => r.id === value)?.fullName ?? "Select repository"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {repos.map((repo) => (
          <SelectItem key={repo.id} value={repo.id}>
            {repo.fullName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function DevflowShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="none" className="w-60">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" className="pointer-events-none">
                <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Sparkles className="size-4" />
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold">DevFlow</span>
                  <span className="text-muted-foreground text-xs">
                    Engineering Copilot
                  </span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {NAV_GROUPS.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const active =
                      item.href === "/devflow"
                        ? pathname === "/devflow"
                        : pathname.startsWith(item.href);
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          isActive={active}
                          render={<Link href={item.href} />}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link href="/" />}>
                <ArrowLeft />
                <span>Yukino OnCall</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 flex-1">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <RepoPicker />
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
