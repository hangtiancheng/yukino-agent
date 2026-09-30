import { createComponentImplementation } from "@a2ui/react/v0_9";

import { AspectRatio as UIAspectRatio } from "@/components/ui/aspect-ratio";
import {
  Alert as UIAlert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  Avatar as UIAvatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge as UIBadge } from "@/components/ui/badge";
import {
  Empty as UIEmpty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item as UIItem,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Kbd as UIKbd, KbdGroup } from "@/components/ui/kbd";
import { Label as UILabel } from "@/components/ui/label";
import {
  Progress as UIProgress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { ScrollArea as UIScrollArea } from "@/components/ui/scroll-area";
import { Skeleton as UISkeleton } from "@/components/ui/skeleton";
import { Spinner as UISpinner } from "@/components/ui/spinner";
import { cn, weightStyle } from "@/lib/utils";
import { CatalogIcon } from "@/catalog/components/icon";
import { ICON_NAME, COMMON } from "./common";
import { z } from "zod/v3";
import {
  ComponentIdSchema,
  DynamicNumberSchema,
  DynamicStringSchema,
} from "@a2ui/web_core/v0_9";

export const AlertApi = {
  name: "Alert",
  schema: z
    .object({
      ...COMMON,
      title: DynamicStringSchema.describe("The alert title."),
      description: DynamicStringSchema.describe(
        "The alert description.",
      ).optional(),
      variant: z
        .enum(["default", "destructive"])
        .default("default")
        .describe("'destructive' renders the alert in an error style."),
      icon: ICON_NAME.optional(),
    })
    .strict(),
};

export const Alert = createComponentImplementation(AlertApi, ({ props }) => (
  <UIAlert
    variant={props.variant === "destructive" ? "destructive" : "default"}
    style={weightStyle(props.weight)}
  >
    <CatalogIcon name={props.icon} />
    <AlertTitle>{props.title}</AlertTitle>
    {props.description && (
      <AlertDescription>{props.description}</AlertDescription>
    )}
  </UIAlert>
));

export const AspectRatioApi = {
  name: "AspectRatio",
  schema: z
    .object({
      ...COMMON,
      ratio: z
        .number()
        .describe("The width / height ratio, e.g. 1.777 for 16:9.")
        .default(1.777),
      child: ComponentIdSchema.describe("The ID of the child component."),
    })
    .strict(),
};

export const AspectRatio = createComponentImplementation(
  AspectRatioApi,
  ({ props, buildChild }) => (
    <div className="w-full" style={weightStyle(props.weight)}>
      <UIAspectRatio ratio={props.ratio ?? 1.777}>
        {props.child ? buildChild(props.child) : null}
      </UIAspectRatio>
    </div>
  ),
);

export const AvatarApi = {
  name: "Avatar",
  schema: z
    .object({
      ...COMMON,
      src: DynamicStringSchema.describe(
        "The image URL of the avatar.",
      ).optional(),
      fallback: DynamicStringSchema.describe(
        "Short fallback text (e.g. initials) shown when the image fails.",
      ),
      size: z
        .enum(["sm", "default", "lg"])
        .default("default")
        .describe("The avatar size."),
    })
    .strict(),
};

export const Avatar = createComponentImplementation(AvatarApi, ({ props }) => (
  <UIAvatar size={props.size ?? "default"} style={weightStyle(props.weight)}>
    {props.src && <AvatarImage src={props.src} />}
    <AvatarFallback>{props.fallback}</AvatarFallback>
  </UIAvatar>
));

export const BadgeApi = {
  name: "Badge",
  schema: z
    .object({
      ...COMMON,
      text: DynamicStringSchema.describe("The badge text."),
      variant: z
        .enum([
          "default",
          "secondary",
          "destructive",
          "outline",
          "ghost",
          "link",
        ])
        .default("default")
        .describe("The badge style; 'link' renders as underlined link text."),
      icon: ICON_NAME.optional(),
    })
    .strict(),
};

export const Badge = createComponentImplementation(BadgeApi, ({ props }) => (
  <UIBadge
    variant={props.variant ?? "default"}
    style={weightStyle(props.weight)}
  >
    <CatalogIcon name={props.icon} />
    {props.text}
  </UIBadge>
));

export const EmptyApi = {
  name: "Empty",
  schema: z
    .object({
      ...COMMON,
      title: DynamicStringSchema.describe("The empty state title."),
      description: DynamicStringSchema.describe(
        "The empty state description.",
      ).optional(),
      icon: ICON_NAME.optional(),
      child: ComponentIdSchema.describe(
        "Optional ID of a child component with follow-up actions.",
      ).optional(),
    })
    .strict(),
};

export const Empty = createComponentImplementation(
  EmptyApi,
  ({ props, buildChild }) => (
    <UIEmpty style={weightStyle(props.weight)}>
      <EmptyHeader>
        {props.icon && (
          <EmptyMedia variant="icon">
            <CatalogIcon name={props.icon} />
          </EmptyMedia>
        )}
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description && (
          <EmptyDescription>{props.description}</EmptyDescription>
        )}
      </EmptyHeader>
      {props.child && <EmptyContent>{buildChild(props.child)}</EmptyContent>}
    </UIEmpty>
  ),
);

export const ItemApi = {
  name: "Item",
  schema: z
    .object({
      ...COMMON,
      title: DynamicStringSchema.describe("The item title."),
      description: DynamicStringSchema.describe(
        "The item description.",
      ).optional(),
      icon: ICON_NAME.optional(),
      child: ComponentIdSchema.describe(
        "Optional ID of a child component rendered as trailing actions.",
      ).optional(),
      variant: z
        .enum(["default", "outline", "muted"])
        .default("default")
        .describe("'outline' adds a border; 'muted' tints the background."),
      size: z
        .enum(["default", "sm", "xs"])
        .default("default")
        .describe("The item density."),
    })
    .strict(),
};

export const Item = createComponentImplementation(
  ItemApi,
  ({ props, buildChild }) => (
    <UIItem
      variant={props.variant ?? "default"}
      size={props.size ?? "default"}
      style={weightStyle(props.weight)}
    >
      {props.icon && (
        <ItemMedia variant="icon">
          <CatalogIcon name={props.icon} />
        </ItemMedia>
      )}
      <ItemContent>
        <ItemTitle>{props.title}</ItemTitle>
        {props.description && (
          <ItemDescription>{props.description}</ItemDescription>
        )}
      </ItemContent>
      {props.child && <ItemActions>{buildChild(props.child)}</ItemActions>}
    </UIItem>
  ),
);

export const KbdApi = {
  name: "Kbd",
  schema: z
    .object({
      ...COMMON,
      keys: z
        .array(z.string())
        .min(1)
        .describe("The keyboard keys to display, e.g. ['Cmd', 'K']."),
    })
    .strict(),
};

export const Kbd = createComponentImplementation(KbdApi, ({ props }) => (
  <KbdGroup style={weightStyle(props.weight)}>
    {(props.keys ?? []).map((key: string, i: number) => (
      <UIKbd key={i}>{key}</UIKbd>
    ))}
  </KbdGroup>
));

export const LabelApi = {
  name: "Label",
  schema: z
    .object({
      ...COMMON,
      text: DynamicStringSchema.describe("The label text."),
    })
    .strict(),
};

export const Label = createComponentImplementation(LabelApi, ({ props }) => (
  <UILabel style={weightStyle(props.weight)}>{props.text}</UILabel>
));

export const ProgressApi = {
  name: "Progress",
  schema: z
    .object({
      ...COMMON,
      value: DynamicNumberSchema.describe(
        "The progress value between 0 and 100.",
      ),
      label: DynamicStringSchema.describe(
        "Optional label shown above the bar.",
      ).optional(),
      showValue: z
        .boolean()
        .describe("Whether to display the percentage value.")
        .optional(),
    })
    .strict(),
};

export const Progress = createComponentImplementation(
  ProgressApi,
  ({ props }) => (
    <UIProgress
      value={typeof props.value === "number" ? props.value : 0}
      style={weightStyle(props.weight)}
    >
      {props.label && <ProgressLabel>{props.label}</ProgressLabel>}
      {props.showValue && <ProgressValue />}
    </UIProgress>
  ),
);

export const ScrollAreaApi = {
  name: "ScrollArea",
  schema: z
    .object({
      ...COMMON,
      child: ComponentIdSchema.describe(
        "The ID of the scrollable child component.",
      ),
      height: z
        .number()
        .describe(
          "The fixed viewport height in pixels; content taller than this scrolls.",
        )
        .default(320),
    })
    .strict(),
};

export const ScrollArea = createComponentImplementation(
  ScrollAreaApi,
  ({ props, buildChild }) => (
    <UIScrollArea
      className="w-full"
      style={{ ...weightStyle(props.weight), height: props.height ?? 320 }}
    >
      {props.child ? buildChild(props.child) : null}
    </UIScrollArea>
  ),
);

export const SkeletonApi = {
  name: "Skeleton",
  schema: z
    .object({
      ...COMMON,
      width: z
        .number()
        .describe("Width in pixels; omit for full width.")
        .optional(),
      height: z.number().describe("Height in pixels.").optional(),
      shape: z
        .enum(["rectangle", "circle", "text"])
        .default("rectangle")
        .describe(
          "'text' renders a text-line height; 'circle' defaults to 16px when width is omitted.",
        ),
    })
    .strict(),
};

export const Skeleton = createComponentImplementation(
  SkeletonApi,
  ({ props }) => {
    const circle = props.shape === "circle";
    const width = circle ? (props.width ?? 16) : props.width;

    return (
      <UISkeleton
        className={cn(
          props.shape === "circle" && "rounded-full",
          props.shape === "text" && "h-4",
        )}
        style={{
          ...weightStyle(props.weight),
          width,
          height:
            props.shape === "text"
              ? undefined
              : (props.height ?? (circle ? width : 16)),
        }}
      />
    );
  },
);

export const SpinnerApi = {
  name: "Spinner",
  schema: z
    .object({
      ...COMMON,
      size: z.number().describe("The size in pixels.").optional(),
    })
    .strict(),
};

export const Spinner = createComponentImplementation(
  SpinnerApi,
  ({ props }) => (
    <UISpinner
      style={{
        ...weightStyle(props.weight),
        width: props.size,
        height: props.size,
      }}
    />
  ),
);
