import { createComponentImplementation } from "@a2ui/react/v0_9";
import { DividerApi } from "@a2ui/web_core/v0_9/basic_catalog";

import { Separator } from "@/components/ui/separator";

export const Divider = createComponentImplementation(
  DividerApi,
  ({ props }) => {
    return (
      <Separator
        orientation={props.axis === "vertical" ? "vertical" : "horizontal"}
      />
    );
  },
);
