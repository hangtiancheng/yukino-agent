import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
} from "recharts";

import { createComponentImplementation } from "@a2ui/react/v0_9";

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { weightStyle } from "@/lib/utils";
import { COMMON } from "./common";
import { DynamicValueSchema } from "@a2ui/web_core/v0_9";

import { z } from "zod/v3";

export const ChartApi = {
  name: "Chart",
  schema: z
    .object({
      ...COMMON,
      variant: z
        .enum(["bar", "line", "area", "pie"])
        .describe("The chart type."),
      data: DynamicValueSchema.describe(
        "The chart rows: an array of objects, or a data model binding to one.",
      ),
      xKey: z
        .string()
        .describe("The row key used for the x axis (or pie slice name)."),
      series: z
        .array(
          z.object({
            key: z
              .string()
              .describe(
                "The row key of this series' value. Use a simple alphanumeric key (it becomes a CSS variable name); put display text in 'label'.",
              ),
            label: z
              .string()
              .describe("The display label of the series.")
              .optional(),
          }),
        )
        .min(1)
        .describe(
          "The value series to plot. Pie charts use only the first series.",
        ),
      height: z.number().describe("The chart height in pixels.").default(240),
    })
    .strict(),
};

type SeriesDef = { key?: unknown; label?: unknown };

// --chart-1 is near-white in the neutral theme, so the rotation stays on
// chart-2..chart-5; a 5th+ series reuses chart-2.
const PALETTE = [
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export const Chart = createComponentImplementation(ChartApi, ({ props }) => {
  const data = (Array.isArray(props.data) ? props.data : []) as Record<
    string,
    unknown
  >[];
  const series = (
    Array.isArray(props.series) ? props.series : []
  ) as SeriesDef[];
  const xKey = String(props.xKey ?? "");

  const config: ChartConfig = Object.fromEntries(
    series.map((s, i) => [
      String(s.key),
      { label: String(s.label ?? s.key), color: PALETTE[i % PALETTE.length] },
    ]),
  );

  const containerProps = {
    config,
    className: "w-full",
    style: { ...weightStyle(props.weight), height: props.height ?? 240 },
  };

  if (props.variant === "pie") {
    const key = String(series[0]?.key ?? "value");
    return (
      <ChartContainer {...containerProps}>
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey={xKey} />} />
          <Pie data={data} dataKey={key} nameKey={xKey}>
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    );
  }

  if (props.variant === "line") {
    return (
      <ChartContainer {...containerProps}>
        <LineChart data={data}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey={xKey}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          {series.map((s, i) => (
            <Line
              key={i}
              dataKey={String(s.key)}
              stroke={`var(--color-${String(s.key)})`}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    );
  }

  if (props.variant === "area") {
    return (
      <ChartContainer {...containerProps}>
        <AreaChart data={data}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey={xKey}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          {series.map((s, i) => (
            <Area
              key={i}
              dataKey={String(s.key)}
              fill={`var(--color-${String(s.key)})`}
              fillOpacity={0.4}
              stroke={`var(--color-${String(s.key)})`}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer {...containerProps}>
      <BarChart data={data}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey={xKey}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {series.map((s, i) => (
          <Bar
            key={i}
            dataKey={String(s.key)}
            fill={`var(--color-${String(s.key)})`}
            radius={4}
          />
        ))}
      </BarChart>
    </ChartContainer>
  );
});
