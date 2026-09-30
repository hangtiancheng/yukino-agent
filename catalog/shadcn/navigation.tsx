import { Fragment } from "react";

import { createComponentImplementation } from "@a2ui/react/v0_9";

import {
  Breadcrumb as UIBreadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Menubar as UIMenubar,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from "@/components/ui/menubar";
import {
  NavigationMenu as UINavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import {
  Pagination as UIPagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { cn, weightStyle } from "@/lib/utils";
import { MENU_ENTRY, COMMON } from "./common";
import { z } from "zod/v3";
import {
  ActionSchema,
  ComponentIdSchema,
  DynamicNumberSchema,
  DynamicStringSchema,
} from "@a2ui/web_core/v0_9";

type MenuEntryDef = {
  label?: unknown;
  action?: unknown;
  variant?: unknown;
  disabled?: unknown;
};

export const BreadcrumbApi = {
  name: "Breadcrumb",
  schema: z
    .object({
      ...COMMON,
      items: z
        .array(
          z.object({
            label: DynamicStringSchema.describe("The crumb label."),
            action: ActionSchema.optional(),
          }),
        )
        .min(1)
        .describe(
          "The breadcrumb trail; the last item renders as the current page and its action is ignored.",
        ),
    })
    .strict(),
};

export const Breadcrumb = createComponentImplementation(
  BreadcrumbApi,
  ({ props }) => {
    const items = (
      Array.isArray(props.items) ? props.items : []
    ) as MenuEntryDef[];

    return (
      <UIBreadcrumb style={weightStyle(props.weight)}>
        <BreadcrumbList>
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <Fragment key={i}>
                <BreadcrumbItem>
                  {isLast ? (
                    <BreadcrumbPage>{String(item.label ?? "")}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      className="cursor-pointer"
                      onClick={
                        typeof item.action === "function"
                          ? (item.action as () => void)
                          : undefined
                      }
                    >
                      {String(item.label ?? "")}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!isLast && <BreadcrumbSeparator />}
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </UIBreadcrumb>
    );
  },
);

export const MenubarApi = {
  name: "Menubar",
  schema: z
    .object({
      ...COMMON,
      menus: z
        .array(
          z.object({
            label: DynamicStringSchema.describe("The menu label."),
            items: z
              .array(MENU_ENTRY)
              .min(1)
              .describe("The entries of this menu."),
          }),
        )
        .min(1)
        .describe("The top-level menus."),
    })
    .strict(),
};

type MenuDef = { label?: unknown; items?: unknown };

export const Menubar = createComponentImplementation(
  MenubarApi,
  ({ props }) => {
    const menus = (Array.isArray(props.menus) ? props.menus : []) as MenuDef[];

    return (
      <UIMenubar style={weightStyle(props.weight)}>
        {menus.map((menu, i) => (
          <MenubarMenu key={i}>
            <MenubarTrigger>{String(menu.label ?? "")}</MenubarTrigger>
            <MenubarContent>
              <MenubarGroup>
                {((menu.items ?? []) as MenuEntryDef[]).map((item, j) => (
                  <MenubarItem
                    key={j}
                    variant={
                      item.variant === "destructive" ? "destructive" : "default"
                    }
                    disabled={!!item.disabled}
                    onClick={
                      typeof item.action === "function"
                        ? (item.action as () => void)
                        : undefined
                    }
                  >
                    {String(item.label ?? "")}
                  </MenubarItem>
                ))}
              </MenubarGroup>
            </MenubarContent>
          </MenubarMenu>
        ))}
      </UIMenubar>
    );
  },
);

export const NavigationMenuApi = {
  name: "NavigationMenu",
  schema: z
    .object({
      ...COMMON,
      items: z
        .array(
          z.object({
            label: DynamicStringSchema.describe("The item label."),
            action: ActionSchema.optional(),
            child: ComponentIdSchema.describe(
              "Optional ID of a component shown as a dropdown panel for this item.",
            ).optional(),
          }),
        )
        .min(1)
        .describe("The navigation items."),
    })
    .strict(),
};

type NavItemDef = { label?: unknown; action?: unknown; child?: unknown };

export const NavigationMenu = createComponentImplementation(
  NavigationMenuApi,
  ({ props, buildChild }) => {
    const items = (
      Array.isArray(props.items) ? props.items : []
    ) as NavItemDef[];

    return (
      <UINavigationMenu style={weightStyle(props.weight)}>
        <NavigationMenuList>
          {items.map((item, i) => (
            <NavigationMenuItem key={i}>
              {typeof item.child === "string" ? (
                <>
                  <NavigationMenuTrigger>
                    {String(item.label ?? "")}
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    {buildChild(item.child)}
                  </NavigationMenuContent>
                </>
              ) : (
                <NavigationMenuLink
                  className="cursor-pointer"
                  onClick={
                    typeof item.action === "function"
                      ? (item.action as () => void)
                      : undefined
                  }
                >
                  {String(item.label ?? "")}
                </NavigationMenuLink>
              )}
            </NavigationMenuItem>
          ))}
        </NavigationMenuList>
      </UINavigationMenu>
    );
  },
);

export const PaginationApi = {
  name: "Pagination",
  schema: z
    .object({
      ...COMMON,
      page: DynamicNumberSchema.describe(
        "The current page (1-based); bind to the data model for two-way sync.",
      ),
      totalPages: z.number().min(1).describe("The total number of pages."),
    })
    .strict(),
};

function pageWindow(page: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, page - 1, page, page + 1]);
  const sorted = [...pages]
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
  const result: (number | "ellipsis")[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) result.push("ellipsis");
    result.push(sorted[i]);
  }
  return result;
}

export const Pagination = createComponentImplementation(
  PaginationApi,
  ({ props }) => {
    const total = typeof props.totalPages === "number" ? props.totalPages : 1;
    const page = Math.min(
      Math.max(typeof props.page === "number" ? props.page : 1, 1),
      total,
    );
    const go = (next: number) =>
      props.setPage(Math.min(Math.max(next, 1), total));
    const atFirst = page <= 1;
    const atLast = page >= total;

    return (
      <UIPagination style={weightStyle(props.weight)}>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              className={cn(
                "cursor-pointer",
                atFirst && "pointer-events-none opacity-50",
              )}
              aria-disabled={atFirst || undefined}
              onClick={() => !atFirst && go(page - 1)}
            />
          </PaginationItem>
          {pageWindow(page, total).map((entry, i) => (
            <PaginationItem key={i}>
              {entry === "ellipsis" ? (
                <PaginationEllipsis />
              ) : (
                <PaginationLink
                  className="cursor-pointer"
                  isActive={entry === page}
                  onClick={() => go(entry)}
                >
                  {entry}
                </PaginationLink>
              )}
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext
              className={cn(
                "cursor-pointer",
                atLast && "pointer-events-none opacity-50",
              )}
              aria-disabled={atLast || undefined}
              onClick={() => !atLast && go(page + 1)}
            />
          </PaginationItem>
        </PaginationContent>
      </UIPagination>
    );
  },
);
