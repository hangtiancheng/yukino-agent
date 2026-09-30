import { createComponentImplementation } from "@a2ui/react/v0_9";
import { FileIcon } from "lucide-react";

import {
  Attachment as UIAttachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Bubble as UIBubble, BubbleContent } from "@/components/ui/bubble";
import {
  Marker as UIMarker,
  MarkerContent,
  MarkerIcon,
} from "@/components/ui/marker";
import { Message as UIMessage, MessageContent } from "@/components/ui/message";
import {
  MessageScroller as UIMessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Questionnaire as UIQuestionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { CatalogIcon } from "@/catalog/components/icon";
import { weightStyle } from "@/lib/utils";
import { ICON_NAME, COMMON } from "./common";
import { z } from "zod/v3";
import {
  ActionSchema,
  ChildListSchema,
  ComponentIdSchema,
  DataBindingSchema,
  DynamicStringSchema,
  DynamicValueSchema,
  FunctionCallSchema,
} from "@a2ui/web_core/v0_9";

export const AttachmentApi = {
  name: "Attachment",
  schema: z
    .object({
      ...COMMON,
      title: DynamicStringSchema.describe("The attachment file name or title."),
      description: DynamicStringSchema.describe(
        "Secondary text such as size or type.",
      ).optional(),
      imageUrl: DynamicStringSchema.describe(
        "Optional thumbnail image URL.",
      ).optional(),
      icon: ICON_NAME.optional(),
      size: z
        .enum(["default", "sm", "xs"])
        .default("default")
        .describe("The attachment density."),
      orientation: z
        .enum(["horizontal", "vertical"])
        .default("horizontal")
        .describe("'vertical' stacks the media above the text as a tile."),
    })
    .strict(),
};

export const Attachment = createComponentImplementation(
  AttachmentApi,
  ({ props }) => (
    <UIAttachment
      size={props.size ?? "default"}
      orientation={props.orientation ?? "horizontal"}
      style={weightStyle(props.weight)}
    >
      <AttachmentMedia variant={props.imageUrl ? "image" : "icon"}>
        {props.imageUrl ? (
          <img src={props.imageUrl} alt="" />
        ) : props.icon ? (
          <CatalogIcon name={props.icon} className="size-4" />
        ) : (
          <FileIcon />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{props.title}</AttachmentTitle>
        {props.description && (
          <AttachmentDescription>{props.description}</AttachmentDescription>
        )}
      </AttachmentContent>
    </UIAttachment>
  ),
);

export const BubbleApi = {
  name: "Bubble",
  schema: z
    .object({
      ...COMMON,
      child: ComponentIdSchema.describe(
        "The ID of the bubble content component.",
      ),
      align: z
        .enum(["start", "end"])
        .default("start")
        .describe(
          "'end' renders as a sent message, 'start' as a received one.",
        ),
      variant: z
        .enum([
          "default",
          "secondary",
          "muted",
          "tinted",
          "outline",
          "ghost",
          "destructive",
        ])
        .default("default")
        .describe(
          "The bubble color treatment: 'default' uses the primary color (own messages), 'secondary'/'muted'/'tinted'/'outline' suit received messages, 'ghost' removes the background, 'destructive' signals errors.",
        ),
    })
    .strict(),
};

export const Bubble = createComponentImplementation(
  BubbleApi,
  ({ props, buildChild }) => (
    <UIBubble
      align={props.align === "end" ? "end" : "start"}
      variant={props.variant ?? "default"}
      style={weightStyle(props.weight)}
    >
      <BubbleContent>
        {props.child ? buildChild(props.child) : null}
      </BubbleContent>
    </UIBubble>
  ),
);

export const MarkerApi = {
  name: "Marker",
  schema: z
    .object({
      ...COMMON,
      text: DynamicStringSchema.describe(
        "The marker text, e.g. a date or system note.",
      ),
      icon: ICON_NAME.optional(),
      variant: z.enum(["default", "separator", "border"]).default("default"),
    })
    .strict(),
};

export const Marker = createComponentImplementation(MarkerApi, ({ props }) => (
  <UIMarker
    variant={props.variant ?? "default"}
    style={weightStyle(props.weight)}
  >
    {props.icon && (
      <MarkerIcon>
        <CatalogIcon name={props.icon} className="size-4" />
      </MarkerIcon>
    )}
    <MarkerContent>{props.text}</MarkerContent>
  </UIMarker>
));

export const MessageApi = {
  name: "Message",
  schema: z
    .object({
      ...COMMON,
      child: ComponentIdSchema.describe(
        "The ID of the message content component.",
      ),
      align: z
        .enum(["start", "end"])
        .default("start")
        .describe("'end' aligns the message to the right (own messages)."),
    })
    .strict(),
};

export const Message = createComponentImplementation(
  MessageApi,
  ({ props, buildChild }) => (
    <UIMessage
      align={props.align === "end" ? "end" : "start"}
      style={weightStyle(props.weight)}
    >
      <MessageContent>
        {props.child ? buildChild(props.child) : null}
      </MessageContent>
    </UIMessage>
  ),
);

export const MessageScrollerApi = {
  name: "MessageScroller",
  schema: z
    .object({
      ...COMMON,
      children: ChildListSchema.describe(
        "The IDs of the message components, oldest first.",
      ),
      height: z
        .number()
        .describe("The viewport height in pixels.")
        .default(320),
    })
    .strict(),
};

type ChildRef = string | { id: string; basePath: string };

export const MessageScroller = createComponentImplementation(
  MessageScrollerApi,
  ({ props, buildChild }) => {
    const children = (
      Array.isArray(props.children) ? props.children : []
    ) as ChildRef[];

    return (
      <div
        className="w-full"
        style={{ ...weightStyle(props.weight), height: props.height ?? 320 }}
      >
        <MessageScrollerProvider>
          <UIMessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                {children.map((ref, i) => (
                  <MessageScrollerItem key={i}>
                    {typeof ref === "string"
                      ? buildChild(ref)
                      : buildChild(ref.id, ref.basePath)}
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </UIMessageScroller>
        </MessageScrollerProvider>
      </div>
    );
  },
);

export const QuestionnaireApi = {
  name: "Questionnaire",
  schema: z
    .object({
      ...COMMON,
      items: z
        .array(
          z.object({
            name: z.string().describe("A unique name for the question."),
            title: DynamicStringSchema.describe("The question text."),
            description: DynamicStringSchema.describe(
              "Optional helper text.",
            ).optional(),
            multiple: z
              .boolean()
              .describe("Whether several choices may be selected.")
              .optional(),
            optional: z
              .boolean()
              .describe(
                "If true, the question can be skipped via a Skip button.",
              )
              .optional(),
            input: z
              .boolean()
              .describe(
                "If true, renders a free-text input instead of choices.",
              )
              .optional(),
            choices: DynamicValueSchema.describe(
              "The choices: an array of {label, value, description?} string objects, or a data model binding to such an array. Falls back to a free-text input when omitted or empty.",
            ).optional(),
            value: z
              .union([
                z.string(),
                z.array(z.string()),
                DataBindingSchema,
                FunctionCallSchema,
              ])
              .describe(
                "The answer: a string array of selected values for choice questions, or a string for free-text questions; bind to the data model for two-way sync.",
              )
              .optional(),
          }),
        )
        .min(1)
        .describe("The questions."),
      submitAction: ActionSchema.describe(
        "The action dispatched when the questionnaire is submitted on the last question.",
      ).optional(),
    })
    .strict(),
};

type QuestionDef = {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  multiple?: unknown;
  optional?: unknown;
  input?: unknown;
  choices?: unknown;
  value?: unknown;
  setValue?: (value: string | string[]) => void;
};
type ChoiceDef = { label?: unknown; value?: unknown; description?: unknown };

const toChoices = (raw: unknown): ChoiceDef[] =>
  Array.isArray(raw) ? (raw as ChoiceDef[]) : [];

export const Questionnaire = createComponentImplementation(
  QuestionnaireApi,
  ({ props }) => {
    const items = (
      Array.isArray(props.items) ? props.items : []
    ) as QuestionDef[];

    return (
      <UIQuestionnaire
        style={weightStyle(props.weight)}
        onSubmit={(event) => {
          event.preventDefault();
          if (typeof props.submitAction === "function") props.submitAction();
        }}
        items={items.map((item, i) => ({
          name: String(item.name ?? `question-${i}`),
          required: !item.optional,
          ...(item.input || toChoices(item.choices).length === 0
            ? {}
            : {
                choices: toChoices(item.choices).map((c) => ({
                  value: String(c.value ?? ""),
                })),
              }),
        }))}
      >
        {items.map((item, i) => {
          const name = String(item.name ?? `question-${i}`);
          const raw = item.value;
          const selected = Array.isArray(raw)
            ? (raw as unknown[]).map(String)
            : typeof raw === "string" && raw
              ? [raw]
              : [];
          const useInput = !!item.input || toChoices(item.choices).length === 0;
          const toggle = (value: string, checked: boolean) => {
            const next = item.multiple
              ? checked
                ? [...selected.filter((v) => v !== value), value]
                : selected.filter((v) => v !== value)
              : checked
                ? [value]
                : [];
            item.setValue?.(next);
          };

          return (
            <QuestionnaireItem
              key={i}
              name={name}
              multiple={!!item.multiple}
              required={!item.optional}
            >
              <QuestionnaireTitle>
                {String(item.title ?? "")}
              </QuestionnaireTitle>
              {item.description ? (
                <QuestionnaireDescription>
                  {String(item.description)}
                </QuestionnaireDescription>
              ) : null}
              {useInput ? (
                <QuestionnaireInput
                  value={typeof item.value === "string" ? item.value : ""}
                  onChange={(e) => item.setValue?.(e.target.value)}
                />
              ) : (
                <QuestionnaireChoices>
                  {toChoices(item.choices).map((choice, j) => {
                    const value = String(choice.value ?? "");
                    return (
                      <QuestionnaireChoice
                        key={j}
                        value={value}
                        checked={selected.includes(value)}
                        onChange={(e) => toggle(value, e.target.checked)}
                      >
                        {String(choice.label ?? value)}
                        {choice.description ? (
                          <QuestionnaireChoiceDescription>
                            {String(choice.description)}
                          </QuestionnaireChoiceDescription>
                        ) : null}
                      </QuestionnaireChoice>
                    );
                  })}
                </QuestionnaireChoices>
              )}
            </QuestionnaireItem>
          );
        })}
        <QuestionnaireActions>
          <QuestionnairePrevious />
          <QuestionnaireSkip />
          <QuestionnaireNext />
          <QuestionnaireSubmit />
        </QuestionnaireActions>
      </UIQuestionnaire>
    );
  },
);
