import { createComponentImplementation } from "@a2ui/react/v0_9";
import { ImageApi } from "@a2ui/web_core/v0_9/basic_catalog";

import {
  cn,
  weightStyle,
  FIT_CLASSES,
  IMAGE_VARIANT_CLASSES,
} from "@/lib/utils";

export const Image = createComponentImplementation(ImageApi, ({ props }) => {
  return (
    <img
      src={props.url}
      alt={props.description || ""}
      className={cn(
        "block rounded-lg",
        FIT_CLASSES[props.fit ?? "fill"],
        props.variant ? IMAGE_VARIANT_CLASSES[props.variant] : undefined,
      )}
      style={weightStyle(props.weight)}
    />
  );
});
