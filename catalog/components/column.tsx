import { createComponentImplementation } from "@a2ui/react/v0_9";
import { ColumnApi } from "@a2ui/web_core/v0_9/basic_catalog";

import { ChildList } from "./child-list";
import { cn, alignClass, justifyClass, weightStyle } from "@/lib/utils";

export const Column = createComponentImplementation(
  ColumnApi,
  ({ props, buildChild }) => {
    return (
      <div
        className={cn(
          "flex flex-col gap-3",
          justifyClass(props.justify),
          alignClass(props.align),
        )}
        style={weightStyle(props.weight)}
      >
        <ChildList childList={props.children} buildChild={buildChild} />
      </div>
    );
  },
);
