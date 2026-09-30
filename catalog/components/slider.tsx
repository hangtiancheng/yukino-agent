import { createComponentImplementation } from "@a2ui/react/v0_9";
import { SliderApi } from "@a2ui/web_core/v0_9/basic_catalog";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Slider as UISlider } from "@/components/ui/slider";

export const Slider = createComponentImplementation(SliderApi, ({ props }) => {
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const value = typeof props.value === "number" ? props.value : min;
  const errors = props.validationErrors;
  const hasError = !!errors && errors.length > 0;

  return (
    <Field data-invalid={hasError || undefined}>
      <div className="flex items-center justify-between">
        {props.label && <FieldLabel>{props.label}</FieldLabel>}
        <span className="text-muted-foreground text-xs">{value}</span>
      </div>
      <UISlider
        min={min}
        max={max}
        value={[value]}
        onValueChange={(v) =>
          props.setValue(Array.isArray(v) ? Number(v[0]) : Number(v))
        }
      />
      {hasError && <FieldError>{errors[0]}</FieldError>}
    </Field>
  );
});
