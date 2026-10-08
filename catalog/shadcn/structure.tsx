import { Fragment } from "react";

import { createComponentImplementation } from "@a2ui/react/v0_9";
import { ChevronDownIcon } from "lucide-react";

import {
  Accordion as UIAccordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ButtonGroup as UIButtonGroup } from "@/components/ui/button-group";
import {
  Carousel as UICarousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import {
  Collapsible as UICollapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Table as UITable,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ChildList } from "@/catalog/components/child-list";
import { weightStyle } from "@/lib/utils";
import { COMMON } from "./common";
import { z } from "zod/v3";
import {
  ChildListSchema,
  ComponentIdSchema,
  DynamicStringSchema,
  DynamicValueSchema,
} from "@a2ui/web_core/v0_9";

export const AccordionApi = {
  name: "Accordion",
  schema: z
    .object({
      ...COMMON,
      items: z
        .array(
          z.object({
            title: DynamicStringSchema.describe("The section title."),
            child: ComponentIdSchema.describe(
              "The ID of the section content component.",
            ),
          }),
        )
        .min(1)
        .describe("The accordion sections."),
    })
    .strict(),
};

type AccordionItemDef = { title?: unknown; child?: unknown };

export const Accordion = createComponentImplementation(
  AccordionApi,
  ({ props, buildChild }) => {
    const items = (
      Array.isArray(props.items) ? props.items : []
    ) as AccordionItemDef[];

    return (
      <UIAccordion style={weightStyle(props.weight)}>
        {items.map((item, i) => (
          <AccordionItem key={i} value={i}>
            <AccordionTrigger>{String(item.title ?? "")}</AccordionTrigger>
            <AccordionContent>
              {typeof item.child === "string" ? buildChild(item.child) : null}
            </AccordionContent>
          </AccordionItem>
        ))}
      </UIAccordion>
    );
  },
);

export const ButtonGroupApi = {
  name: "ButtonGroup",
  schema: z
    .object({
      ...COMMON,
      children: ChildListSchema.describe(
        "The IDs of the grouped Button components.",
      ),
      orientation: z
        .enum(["horizontal", "vertical"])
        .default("horizontal")
        .describe("'vertical' stacks the buttons top to bottom."),
    })
    .strict(),
};

export const ButtonGroup = createComponentImplementation(
  ButtonGroupApi,
  ({ props, buildChild }) => (
    <UIButtonGroup
      orientation={props.orientation === "vertical" ? "vertical" : "horizontal"}
      style={weightStyle(props.weight)}
    >
      <ChildList childList={props.children} buildChild={buildChild} />
    </UIButtonGroup>
  ),
);

export const CarouselApi = {
  name: "Carousel",
  schema: z
    .object({
      ...COMMON,
      children: ChildListSchema.describe("The IDs of the slide components."),
      orientation: z
        .enum(["horizontal", "vertical"])
        .default("horizontal")
        .describe(
          "'vertical' stacks slides and pages up/down inside a fixed-height viewport.",
        ),
    })
    .strict(),
};

type ChildRef = string | { id: string; basePath: string };

export const Carousel = createComponentImplementation(
  CarouselApi,
  ({ props, buildChild }) => {
    const children = (
      Array.isArray(props.children) ? props.children : []
    ) as ChildRef[];
    const vertical = props.orientation === "vertical";

    return (
      <UICarousel
        orientation={vertical ? "vertical" : "horizontal"}
        className={cn("w-full", vertical ? "my-12" : "mx-12")}
        style={weightStyle(props.weight)}
      >
        <CarouselContent className={vertical ? "h-64" : undefined}>
          {children.map((ref, i) => (
            <CarouselItem key={i}>
              {typeof ref === "string"
                ? buildChild(ref)
                : buildChild(ref.id, ref.basePath)}
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </UICarousel>
    );
  },
);

export const CollapsibleApi = {
  name: "Collapsible",
  schema: z
    .object({
      ...COMMON,
      label: DynamicStringSchema.describe("The trigger label."),
      child: ComponentIdSchema.describe(
        "The ID of the collapsible content component.",
      ),
      defaultOpen: z
        .boolean()
        .describe("Whether the section starts expanded.")
        .optional(),
    })
    .strict(),
};

export const Collapsible = createComponentImplementation(
  CollapsibleApi,
  ({ props, buildChild }) => (
    <UICollapsible
      defaultOpen={!!props.defaultOpen}
      className="w-full"
      style={weightStyle(props.weight)}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 text-sm font-medium">
        {props.label}
        <ChevronDownIcon className="text-muted-foreground size-4" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {props.child ? buildChild(props.child) : null}
      </CollapsibleContent>
    </UICollapsible>
  ),
);

export const ResizableApi = {
  name: "Resizable",
  schema: z
    .object({
      ...COMMON,
      direction: z
        .enum(["horizontal", "vertical"])
        .default("horizontal")
        .describe("'vertical' stacks the panels top to bottom."),
      panels: z
        .array(
          z.object({
            child: ComponentIdSchema.describe(
              "The ID of the panel content component.",
            ),
            defaultSize: z
              .number()
              .describe("The initial size as a percentage.")
              .optional(),
          }),
        )
        .min(2)
        .describe("The resizable panels."),
    })
    .strict(),
};

type PanelDef = { child?: unknown; defaultSize?: unknown };

export const Resizable = createComponentImplementation(
  ResizableApi,
  ({ props, buildChild }) => {
    const panels = (
      Array.isArray(props.panels) ? props.panels : []
    ) as PanelDef[];

    return (
      <ResizablePanelGroup
        orientation={props.direction === "vertical" ? "vertical" : "horizontal"}
        className="min-h-32 w-full rounded-lg border"
        style={weightStyle(props.weight)}
      >
        {panels.map((panel, i) => (
          <Fragment key={i}>
            {i > 0 && <ResizableHandle withHandle />}
            <ResizablePanel
              defaultSize={
                typeof panel.defaultSize === "number"
                  ? String(panel.defaultSize)
                  : undefined
              }
            >
              <div className="p-3">
                {typeof panel.child === "string"
                  ? buildChild(panel.child)
                  : null}
              </div>
            </ResizablePanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    );
  },
);

export const TableApi = {
  name: "Table",
  schema: z
    .object({
      ...COMMON,
      caption: DynamicStringSchema.describe(
        "Optional table caption.",
      ).optional(),
      columns: z
        .array(
          z.object({
            key: z.string().describe("The row object key for this column."),
            header: z.string().describe("The column header label."),
          }),
        )
        .min(1)
        .describe("The table columns."),
      rows: DynamicValueSchema.describe(
        "The table rows: an array of objects keyed by column keys, or a data model binding to one.",
      ),
    })
    .strict(),
};

type ColumnDef = { key?: unknown; header?: unknown };

export const Table = createComponentImplementation(TableApi, ({ props }) => {
  const columns = (
    Array.isArray(props.columns) ? props.columns : []
  ) as ColumnDef[];
  const rows = (Array.isArray(props.rows) ? props.rows : []) as Record<
    string,
    unknown
  >[];

  return (
    <div className="w-full" style={weightStyle(props.weight)}>
      <UITable>
        {props.caption && <TableCaption>{props.caption}</TableCaption>}
        <TableHeader>
          <TableRow>
            {columns.map((col, i) => (
              <TableHead key={i}>{String(col.header ?? "")}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, ri) => (
            <TableRow key={ri}>
              {columns.map((col, ci) => {
                const cell = row?.[String(col.key)];
                return (
                  <TableCell key={ci}>
                    {typeof cell === "object" && cell !== null
                      ? JSON.stringify(cell)
                      : String(cell ?? "")}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </UITable>
    </div>
  );
});
