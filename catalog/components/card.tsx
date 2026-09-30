import { createComponentImplementation } from "@a2ui/react/v0_9";
import { CardApi } from "@a2ui/web_core/v0_9/basic_catalog";

import { Card as UICard, CardContent } from "@/components/ui/card";
import { weightStyle } from "@/lib/utils";

export const Card = createComponentImplementation(
  CardApi,
  ({ props, buildChild }) => {
    return (
      <UICard style={weightStyle(props.weight)}>
        <CardContent>
          {props.child ? buildChild(props.child) : null}
        </CardContent>
      </UICard>
    );
  },
);
