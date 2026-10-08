import { useId, useState } from "react";

import { createComponentImplementation } from "@a2ui/react/v0_9";
import { DateTimeInputApi } from "@a2ui/web_core/v0_9/basic_catalog";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function splitValue(value: string | null | undefined): {
  date: string;
  time: string;
} {
  if (!value) return { date: "", time: "" };

  const hasT = value.includes("T");
  const split = value.split("T");
  const rawDate = (hasT ? split[0] : value) ?? "";
  const rawTime = (hasT ? split[1] : value) ?? "";

  return {
    date: /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.substring(0, 10) : "",
    time: /^\d{2}:\d{2}/.test(rawTime) ? rawTime.substring(0, 5) : "",
  };
}

function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Official shadcn date-picker time pattern: suppress the native picker
// indicator so only the styled input remains.
const TIME_INPUT_CLASSES =
  "appearance-none bg-background [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none";

export const DateTimeInput = createComponentImplementation(
  DateTimeInputApi,
  ({ props }) => {
    const id = useId();
    const [open, setOpen] = useState(false);

    const enableDate = !!props.enableDate;
    const enableTime = !!props.enableTime;
    if (!(enableDate || enableTime)) return null;

    const errors = props.validationErrors;
    const hasError = !!errors && errors.length > 0;
    const { date, time } = splitValue(props.value);
    const selected = date ? new Date(`${date}T00:00:00`) : undefined;

    const min = typeof props.min === "string" ? props.min : undefined;
    const max = typeof props.max === "string" ? props.max : undefined;
    const minParts = splitValue(min);
    const maxParts = splitValue(max);
    const disabledDays = [
      ...(minParts.date
        ? [{ before: new Date(`${minParts.date}T00:00:00`) }]
        : []),
      ...(maxParts.date
        ? [{ after: new Date(`${maxParts.date}T00:00:00`) }]
        : []),
    ];

    // A time bound only applies on the bound's own day (or in time-only mode).
    const timeBound = (bound: { date: string; time: string }) =>
      bound.time && (!enableDate || (date && date === bound.date))
        ? bound.time
        : undefined;

    const commit = (nextDate: string, nextTime: string) => {
      if (enableDate && enableTime) {
        if (!nextDate) {
          props.setValue(nextTime);
          return;
        }
        props.setValue(nextTime ? `${nextDate}T${nextTime}` : nextDate);
        return;
      }
      props.setValue(enableDate ? nextDate : nextTime);
    };

    return (
      <Field data-invalid={hasError || undefined}>
        {props.label && (
          <FieldLabel htmlFor={enableTime ? id : undefined}>
            {props.label}
          </FieldLabel>
        )}
        <div className="flex items-center gap-2">
          {enableDate && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    className={cn(
                      "flex-1 justify-start font-normal",
                      !date && "text-muted-foreground",
                    )}
                  />
                }
              >
                <CalendarIcon data-icon="inline-start" />
                {selected ? format(selected, "PPP") : "Pick a date"}
              </PopoverTrigger>
              <PopoverContent
                className="w-auto overflow-hidden p-0"
                align="start"
              >
                <Calendar
                  mode="single"
                  selected={selected}
                  captionLayout="dropdown"
                  defaultMonth={selected}
                  disabled={disabledDays.length ? disabledDays : undefined}
                  onSelect={(next) => {
                    if (next instanceof Date && !Number.isNaN(next.getTime())) {
                      commit(toIsoDate(next), time);
                      setOpen(false);
                    }
                  }}
                />
              </PopoverContent>
            </Popover>
          )}
          {enableTime && (
            <Input
              id={id}
              type="time"
              value={time}
              min={timeBound(minParts)}
              max={timeBound(maxParts)}
              onChange={(e) => commit(date, e.target.value)}
              aria-invalid={hasError || undefined}
              className={cn(TIME_INPUT_CLASSES, enableDate && "w-32")}
            />
          )}
        </div>
        {hasError && <FieldError>{errors[0]}</FieldError>}
      </Field>
    );
  },
);
