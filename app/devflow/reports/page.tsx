"use client";

// Weekly Reports: generate an engineering report for a date range; the report
// is also stored in the repository knowledge base for later RAG citations.
import { useState } from "react";
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
  const [startDate, setStartDate] = useState(isoDaysAgo(7));
  const [endDate, setEndDate] = useState(isoDaysAgo(0));
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    if (!repoId) return;
    if (startDate > endDate) {
      notify.error("Start date must be before end date.");
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
      notify.success("Weekly report generated and saved to the knowledge base");
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title="Weekly Reports"
        description={
          repo
            ? `Generate an engineering weekly for ${repo.fullName} from synced issues, PRs and CI runs.`
            : "Select a repository to generate its weekly report"
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-5">
          <div className="space-y-1.5">
            <Label htmlFor="report-start">Start date</Label>
            <Input
              id="report-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-end">End date</Label>
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
            {generating ? "Generating…" : "Generate report"}
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
            <Badge variant="secondary">{report.metrics.issues} issues</Badge>
            <Badge variant="secondary">{report.metrics.pullRequests} PRs</Badge>
            <Badge variant="secondary">{report.metrics.mergedPrs} merged</Badge>
            <Badge variant="secondary">{report.metrics.openPrs} open PRs</Badge>
            <Badge
              variant={
                report.metrics.failedCi > 0 ? "destructive" : "secondary"
              }
            >
              {report.metrics.failedCi} failed CI
            </Badge>
          </div>
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <FileText className="text-muted-foreground size-4" />
                Report {startDate} → {endDate}
                {report.knowledgeDocId ? (
                  <Badge variant="outline" className="ml-auto">
                    saved to knowledge base
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
            <p className="text-foreground text-sm font-medium">No report yet</p>
            <p className="text-muted-foreground max-w-sm text-xs">
              Pick a date range and generate — the report covers completed work,
              risks, PRs needing attention, failed CI and next-week suggestions.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
