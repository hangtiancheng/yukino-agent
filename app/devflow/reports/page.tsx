"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarRange, FileText, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/devflow/notify";
import PageHeader from "@/components/devflow/page-header";
import DevflowMarkdown from "@/components/devflow/markdown";
import { dfPost, useDevflow } from "@/components/devflow/provider";

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

interface WeeklyReport {
  reportMarkdown: string;
  metrics: {
    issues: number;
    pullRequests: number;
    mergedPrs: number;
    openPrs: number;
    failedCi: number;
  };
  knowledgeDocId: string | null;
}

export default function DevflowReportsPage() {
  const { repoId, repo } = useDevflow();
  const t = useTranslations("devflow.reports");
  const [startDate, setStartDate] = useState(isoDaysAgo(7));
  const [endDate, setEndDate] = useState(isoDaysAgo(0));
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    if (!repoId) return;
    if (startDate > endDate) {
      notify.error(t("invalidRange"));
      return;
    }
    setGenerating(true);
    setReport(null);
    try {
      const result = await dfPost<WeeklyReport>("/reports", {
        repoId,
        startDate,
        endDate,
      });
      setReport(result);
      notify.success(t("generated"));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title={t("title")}
        description={
          repo
            ? t("descriptionRepo", { repo: repo.fullName })
            : t("descriptionNone")
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-5">
          <div className="space-y-1.5">
            <Label htmlFor="report-start">{t("startDate")}</Label>
            <Input
              id="report-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-end">{t("endDate")}</Label>
            <Input
              id="report-end"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <Button
            onClick={() => void generate()}
            disabled={generating || !repoId}
            className="ml-auto"
          >
            {generating ? (
              <Sparkles className="animate-pulse" />
            ) : (
              <CalendarRange />
            )}
            {generating ? t("generating") : t("generate")}
          </Button>
        </CardContent>
      </Card>

      {generating ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-2/3 rounded-lg" />
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      ) : report ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">
              {t("issuesCount", { count: report.metrics.issues })}
            </Badge>
            <Badge variant="secondary">
              {t("prsCount", { count: report.metrics.pullRequests })}
            </Badge>
            <Badge variant="secondary">
              {t("mergedCount", { count: report.metrics.mergedPrs })}
            </Badge>
            <Badge variant="secondary">
              {t("openPrsCount", { count: report.metrics.openPrs })}
            </Badge>
            <Badge
              variant={
                report.metrics.failedCi > 0 ? "destructive" : "secondary"
              }
            >
              {t("failedCiCount", { count: report.metrics.failedCi })}
            </Badge>
          </div>
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <FileText className="text-muted-foreground size-4" />
                {t("reportRange", { start: startDate, end: endDate })}
                {report.knowledgeDocId ? (
                  <Badge variant="outline" className="ml-auto">
                    {t("savedToKb")}
                  </Badge>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DevflowMarkdown content={report.reportMarkdown} />
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <FileText className="text-muted-foreground size-8" />
            <p className="text-foreground text-sm font-medium">
              {t("noReport")}
            </p>
            <p className="text-muted-foreground max-w-sm text-xs">
              {t("noReportDescription")}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
