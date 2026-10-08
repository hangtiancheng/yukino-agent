import { useState } from "react";

import { createComponentImplementation } from "@a2ui/react/v0_9";

import {
  AlertDialog as UIAlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu as UIContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Drawer as UIDrawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  DropdownMenu as UIDropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard as UIHoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Popover as UIPopover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet as UISheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MENU_ENTRY, COMMON } from "./common";
import { z } from "zod/v3";
import {
  ActionSchema,
  ComponentIdSchema,
  DynamicStringSchema,
} from "@a2ui/web_core/v0_9";
type MenuEntryDef = {
  label?: unknown;
  action?: unknown;
  variant?: unknown;
  disabled?: unknown;
};

const TRIGGER = <span className="inline-block" />;

export const AlertDialogApi = {
  name: "AlertDialog",
  schema: z
    .object({
      ...COMMON,
      trigger: ComponentIdSchema.describe(
        "The ID of the component that opens the dialog.",
      ),
      title: DynamicStringSchema.describe("The dialog title."),
      description: DynamicStringSchema.describe(
        "The dialog description.",
      ).optional(),
      cancelLabel: DynamicStringSchema.describe(
        "The cancel button label.",
      ).optional(),
      actionLabel: DynamicStringSchema.describe(
        "The confirm button label.",
      ).optional(),
      action: ActionSchema.describe(
        "The action dispatched on confirm.",
      ).optional(),
    })
    .strict(),
};

export const AlertDialog = createComponentImplementation(
  AlertDialogApi,
  ({ props, buildChild }) => {
    const [open, setOpen] = useState(false);

    return (
      <UIAlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger render={TRIGGER} nativeButton={false}>
          {props.trigger ? buildChild(props.trigger) : null}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{props.title}</AlertDialogTitle>
            {props.description && (
              <AlertDialogDescription>
                {props.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {props.cancelLabel || "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (typeof props.action === "function") props.action();
                setOpen(false);
              }}
            >
              {props.actionLabel || "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </UIAlertDialog>
    );
  },
);

export const ContextMenuApi = {
  name: "ContextMenu",
  schema: z
    .object({
      ...COMMON,
      child: ComponentIdSchema.describe(
        "The ID of the component that acts as the right-click area.",
      ),
      items: z.array(MENU_ENTRY).min(1).describe("The menu entries."),
    })
    .strict(),
};

export const ContextMenu = createComponentImplementation(
  ContextMenuApi,
  ({ props, buildChild }) => (
    <UIContextMenu>
      <ContextMenuTrigger render={TRIGGER}>
        {props.child ? buildChild(props.child) : null}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          {((props.items ?? []) as MenuEntryDef[]).map((item, i) => (
            <ContextMenuItem
              key={i}
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
            </ContextMenuItem>
          ))}
        </ContextMenuGroup>
      </ContextMenuContent>
    </UIContextMenu>
  ),
);

export const DrawerApi = {
  name: "Drawer",
  schema: z
    .object({
      ...COMMON,
      trigger: ComponentIdSchema.describe(
        "The ID of the component that opens the drawer.",
      ),
      title: DynamicStringSchema.describe("The drawer title."),
      description: DynamicStringSchema.describe(
        "The drawer description.",
      ).optional(),
      child: ComponentIdSchema.describe(
        "The ID of the drawer content component.",
      ).optional(),
    })
    .strict(),
};

export const Drawer = createComponentImplementation(
  DrawerApi,
  ({ props, buildChild }) => (
    <UIDrawer>
      <DrawerTrigger render={TRIGGER} nativeButton={false}>
        {props.trigger ? buildChild(props.trigger) : null}
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{props.title}</DrawerTitle>
          {props.description && (
            <DrawerDescription>{props.description}</DrawerDescription>
          )}
        </DrawerHeader>
        {props.child && (
          <div className="px-4 pb-4">{buildChild(props.child)}</div>
        )}
      </DrawerContent>
    </UIDrawer>
  ),
);

export const DropdownMenuApi = {
  name: "DropdownMenu",
  schema: z
    .object({
      ...COMMON,
      trigger: ComponentIdSchema.describe(
        "The ID of the component that opens the menu.",
      ),
      items: z.array(MENU_ENTRY).min(1).describe("The menu entries."),
    })
    .strict(),
};

export const DropdownMenu = createComponentImplementation(
  DropdownMenuApi,
  ({ props, buildChild }) => (
    <UIDropdownMenu>
      <DropdownMenuTrigger render={TRIGGER} nativeButton={false}>
        {props.trigger ? buildChild(props.trigger) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          {((props.items ?? []) as MenuEntryDef[]).map((item, i) => (
            <DropdownMenuItem
              key={i}
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
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </UIDropdownMenu>
  ),
);

export const HoverCardApi = {
  name: "HoverCard",
  schema: z
    .object({
      ...COMMON,
      trigger: ComponentIdSchema.describe(
        "The ID of the component that reveals the card on hover.",
      ),
      child: ComponentIdSchema.describe(
        "The ID of the card content component.",
      ),
    })
    .strict(),
};

export const HoverCard = createComponentImplementation(
  HoverCardApi,
  ({ props, buildChild }) => (
    <UIHoverCard>
      <HoverCardTrigger render={TRIGGER}>
        {props.trigger ? buildChild(props.trigger) : null}
      </HoverCardTrigger>
      <HoverCardContent>
        {props.child ? buildChild(props.child) : null}
      </HoverCardContent>
    </UIHoverCard>
  ),
);

export const PopoverApi = {
  name: "Popover",
  schema: z
    .object({
      ...COMMON,
      trigger: ComponentIdSchema.describe(
        "The ID of the component that opens the popover.",
      ),
      child: ComponentIdSchema.describe(
        "The ID of the popover content component.",
      ),
    })
    .strict(),
};

export const Popover = createComponentImplementation(
  PopoverApi,
  ({ props, buildChild }) => (
    <UIPopover>
      <PopoverTrigger render={TRIGGER} nativeButton={false}>
        {props.trigger ? buildChild(props.trigger) : null}
      </PopoverTrigger>
      <PopoverContent>
        {props.child ? buildChild(props.child) : null}
      </PopoverContent>
    </UIPopover>
  ),
);

export const SheetApi = {
  name: "Sheet",
  schema: z
    .object({
      ...COMMON,
      trigger: ComponentIdSchema.describe(
        "The ID of the component that opens the sheet.",
      ),
      title: DynamicStringSchema.describe("The sheet title."),
      description: DynamicStringSchema.describe(
        "The sheet description.",
      ).optional(),
      child: ComponentIdSchema.describe(
        "The ID of the sheet content component.",
      ).optional(),
      side: z.enum(["top", "right", "bottom", "left"]).default("right"),
    })
    .strict(),
};

export const Sheet = createComponentImplementation(
  SheetApi,
  ({ props, buildChild }) => (
    <UISheet>
      <SheetTrigger render={TRIGGER} nativeButton={false}>
        {props.trigger ? buildChild(props.trigger) : null}
      </SheetTrigger>
      <SheetContent side={props.side ?? "right"}>
        <SheetHeader>
          <SheetTitle>{props.title}</SheetTitle>
          {props.description && (
            <SheetDescription>{props.description}</SheetDescription>
          )}
        </SheetHeader>
        {props.child && (
          <div className="px-4 pb-4">{buildChild(props.child)}</div>
        )}
      </SheetContent>
    </UISheet>
  ),
);

export const TooltipApi = {
  name: "Tooltip",
  schema: z
    .object({
      ...COMMON,
      trigger: ComponentIdSchema.describe(
        "The ID of the component the tooltip is attached to.",
      ),
      text: DynamicStringSchema.describe("The tooltip text."),
    })
    .strict(),
};

export const Tooltip = createComponentImplementation(
  TooltipApi,
  ({ props, buildChild }) => (
    <UITooltip>
      <TooltipTrigger render={TRIGGER}>
        {props.trigger ? buildChild(props.trigger) : null}
      </TooltipTrigger>
      <TooltipContent>{props.text}</TooltipContent>
    </UITooltip>
  ),
);
