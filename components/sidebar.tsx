"use client";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useTranslations } from "next-intl";
import {
  FolderGit2,
  MessageSquare,
  Plus,
  Snowflake,
  Trash2,
} from "lucide-react";
import type { ChatHistory } from "@/hooks/use-chat";
import {
  Sidebar as SidebarPrimitive,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

interface SidebarProps {
  histories: ChatHistory[];
  activeId: string;
  onNewChat: () => void;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function Sidebar({
  histories,
  activeId,
  onNewChat,
  onLoad,
  onDelete,
}: SidebarProps) {
  const t = useTranslations("chat");

  return (
    <SidebarPrimitive
      collapsible="none"
      className="bg-background text-sidebar-foreground w-full"
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="pointer-events-none">
              <div className="from-primary to-chart-2 text-primary-foreground shadow-soft flex aspect-square size-8 items-center justify-center rounded-lg bg-linear-to-br">
                <Snowflake className="size-4" strokeWidth={1.75} />
              </div>
              <span className="truncate font-semibold">{t("appName")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t("recent")}</SidebarGroupLabel>
          <SidebarGroupAction title={t("newChat")} onClick={onNewChat}>
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  variant="outline"
                  onClick={onNewChat}
                  tooltip={t("newChat")}
                >
                  <Plus />
                  <span>{t("newChat")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarMenu className="mt-1">
              <AnimatePresence initial={false}>
                {histories.map((h) => (
                  <motion.li
                    key={h.id}
                    layout
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{
                      height: { duration: 0.25, ease: [0.23, 1, 0.32, 1] },
                      opacity: { duration: 0.2, ease: "easeOut" },
                    }}
                    className="group/menu-item relative overflow-hidden"
                  >
                    <SidebarMenuButton
                      isActive={h.id === activeId}
                      onClick={() => onLoad(h.id)}
                      tooltip={h.title}
                    >
                      <MessageSquare />
                      <span>{h.title}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      onClick={() => onDelete(h.id)}
                      aria-label={t("delete")}
                      className="hover:text-destructive"
                    >
                      <Trash2 />
                    </SidebarMenuAction>
                  </motion.li>
                ))}
              </AnimatePresence>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={t("devflowWorkspaceTooltip")}
                  render={<Link href="/devflow" />}
                >
                  <FolderGit2 />
                  <span>{t("devflowWorkspace")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </SidebarPrimitive>
  );
}
