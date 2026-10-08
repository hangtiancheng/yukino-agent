"use client";

// DevFlow workspace shell: sidebar navigation + top bar with the global
// repository picker, theme toggle and a link back to the main assistant.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations, type Messages } from "next-intl";
import {
  Activity,
  BotMessageSquare,
  BookOpen,
  CircleDot,
  ClipboardCheck,
  Code2,
  FileText,
  FolderGit2,
  GitBranch,
  Boxes,
  LayoutDashboard,
  MessageSquareText,
  Moon,
  Network,
  Share2,
  Workflow,
  GitPullRequest,
  Snowflake,
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
import { LanguageSwitcher } from "@/components/language-switcher";
import { useDevflow } from "./provider";

type DevflowNavKey = keyof Messages["devflow"]["nav"];

const NAV_GROUPS: Array<{
  labelKey: DevflowNavKey;
  items: Array<{
    href: string;
    labelKey: DevflowNavKey;
    icon: typeof Activity;
  }>;
}> = [
  {
    labelKey: "overview",
    items: [{ href: "/devflow", labelKey: "dashboard", icon: LayoutDashboard }],
  },
  {
    labelKey: "delivery",
    items: [
      { href: "/devflow/issues", labelKey: "issues", icon: CircleDot },
      {
        href: "/devflow/pulls",
        labelKey: "pullRequests",
        icon: GitPullRequest,
      },
      { href: "/devflow/ci", labelKey: "ci", icon: Activity },
    ],
  },
  {
    labelKey: "intelligence",
    items: [
      { href: "/devflow/knowledge", labelKey: "knowledge", icon: BookOpen },
      { href: "/devflow/code", labelKey: "code", icon: Code2 },
      { href: "/devflow/code-graph", labelKey: "codeGraph", icon: Network },
      { href: "/devflow/graph", labelKey: "graph", icon: Share2 },
      { href: "/devflow/chat", labelKey: "agentChat", icon: MessageSquareText },
      { href: "/devflow/reports", labelKey: "reports", icon: FileText },
      { href: "/devflow/feedback", labelKey: "feedback", icon: ThumbsUp },
    ],
  },
  {
    labelKey: "operations",
    items: [
      { href: "/devflow/drafts", labelKey: "drafts", icon: ClipboardCheck },
      {
        href: "/devflow/workflow-runs",
        labelKey: "workflowRuns",
        icon: Workflow,
      },
      { href: "/devflow/workspaces", labelKey: "workspaces", icon: Boxes },
      { href: "/devflow/repos", labelKey: "repos", icon: FolderGit2 },
    ],
  },
];

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const t = useTranslations("devflow");
  const isDark = theme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("toggleTheme")}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

function RepoPicker() {
  const { repos, reposLoading, repoId, setRepoId } = useDevflow();
  const t = useTranslations("devflow");
  if (reposLoading) {
    return <Skeleton className="h-8 w-52" />;
  }
  if (repos.length === 0) {
    return (
      <Link href="/devflow/repos">
        <Button variant="outline" size="sm">
          <GitBranch className="size-3.5" />
          {t("connectRepo")}
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
      <SelectTrigger className="w-56" aria-label={t("selectRepo")}>
        <GitBranch className="text-muted-foreground size-3.5" />
        <SelectValue placeholder={t("selectRepo")}>
          {(value: string | null) =>
            repos.find((r) => r.id === value)?.fullName ?? t("selectRepo")
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
  const t = useTranslations("devflow");
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="none" className="w-60">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" className="pointer-events-none">
                <div className="from-primary to-chart-2 text-primary-foreground shadow-soft flex aspect-square size-8 items-center justify-center rounded-lg bg-linear-to-br">
                  <Snowflake className="size-4" strokeWidth={1.75} />
                </div>
                <div className="flex flex-col gap-0.5 leading-none">
                  <span className="font-semibold">{t("title")}</span>
                  <span className="text-muted-foreground text-xs">
                    {t("subtitle")}
                  </span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {NAV_GROUPS.map((group) => (
            <SidebarGroup key={group.labelKey}>
              <SidebarGroupLabel>
                {t(`nav.${group.labelKey}`)}
              </SidebarGroupLabel>
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
                          className="data-active:bg-primary/10 data-active:text-primary data-active:font-semibold"
                        >
                          <item.icon />
                          <span>{t(`nav.${item.labelKey}`)}</span>
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
                <BotMessageSquare />
                <span>{t("backToOncall")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 flex-1">
        <header className="bg-background/75 flex h-14 shrink-0 items-center gap-3 border-b px-4 backdrop-blur-md">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <RepoPicker />
          <div className="ml-auto flex items-center gap-1.5">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
