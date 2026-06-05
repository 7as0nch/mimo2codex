import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  DownloadOutlined,
  ReloadOutlined,
  DeleteOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import {
  api,
  type LogBodyMode,
  type LogDetail,
  type LogSettingsResponse,
  type LogRow,
  type ProviderInfo,
} from "../../api/client";
import { PageTour } from "../../components/PageTour";
import { BodyBlock } from "./BodyBlock";
import { StructuredDetail } from "./StructuredDetail";

const PAGE_SIZE = 100;

type StatusFilter = "all" | "ok" | "error";

// Map a UI status filter chip to the inclusive numeric range we hand the
// server-side query. Defined here (not inside the component) so it's a pure
// function trivially testable in isolation.
function statusBounds(filter: StatusFilter): {
  statusMin?: number;
  statusMax?: number;
} {
  if (filter === "ok") return { statusMin: 200, statusMax: 399 };
  if (filter === "error") return { statusMin: 400, statusMax: 599 };
  return {};
}

// CSV escaping: wrap in quotes when the value contains a delimiter / quote /
// newline, then double-up existing quotes. Excel and LibreOffice both
// understand this dialect.
function csvEscape(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function Logs() {
  const { t } = useTranslation("logs");
  const { t: tTour } = useTranslation("tour");
  const [messageApi, msgCtx] = message.useMessage();
  const filterRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLSpanElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [modal, modalCtx] = Modal.useModal();
  const location = useLocation();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<number, LogDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Set<number>>(new Set());
  // Per-row Structured/Raw toggle in expanded detail view.
  const [detailMode, setDetailMode] = useState<
    Record<number, "structured" | "raw">
  >({});
  // Highlight propagated from ?highlight=<id> in the URL (Dashboard → Logs).
  const [expandedRowKeys, setExpandedRowKeys] = useState<number[]>([]);
  const initialHighlightApplied = useRef(false);
  const [logSettingsOpen, setLogSettingsOpen] = useState(false);
  const [logSettingsLoading, setLogSettingsLoading] = useState(false);
  const [logSettings, setLogSettings] = useState<LogSettingsResponse | null>(
    null
  );
  const [logSettingsForm] = Form.useForm<{
    bodyMode: LogBodyMode;
    retentionDays: number | null;
  }>();

  async function loadProviders() {
    try {
      const r = await api.providers();
      setProviders(r.providers);
    } catch {
      // non-fatal — provider filter falls back to "all" / typed model only
    }
  }

  async function load() {
    try {
      setError(null);
      setLoading(true);
      const r = await api.logs({
        provider: provider || undefined,
        model: model || undefined,
        ...statusBounds(statusFilter),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setLogs(r.logs);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProviders();
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, model, statusFilter, page]);

  // ?highlight=<id> from Dashboard jump → auto-expand the row once loaded.
  useEffect(() => {
    if (initialHighlightApplied.current) return;
    const params = new URLSearchParams(location.search);
    const hl = params.get("highlight");
    if (!hl) return;
    const id = Number(hl);
    if (logs.find((row) => row.id === id)) {
      setExpandedRowKeys([id]);
      void loadDetail(id);
      initialHighlightApplied.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  async function loadDetail(id: number) {
    if (details[id] || detailLoading.has(id)) return;
    setDetailLoading((prev) => new Set(prev).add(id));
    try {
      const r = await api.logDetail(id);
      setDetails((prev) => ({ ...prev, [id]: r.log }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDetailLoading((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function openLogSettings() {
    setLogSettingsLoading(true);
    try {
      const settings = await api.logSettings();
      setLogSettings(settings);
      logSettingsForm.setFieldsValue({
        bodyMode: settings.bodyMode,
        retentionDays: settings.retentionDays,
      });
      setLogSettingsOpen(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLogSettingsLoading(false);
    }
  }

  async function saveLogSettings() {
    const values = await logSettingsForm.validateFields();
    try {
      await api.setLogSettings({
        bodyMode: values.bodyMode,
        retentionDays: values.retentionDays ?? null,
      });
      messageApi.success(t("storage.saved"));
      setLogSettingsOpen(false);
      setLogSettings(await api.logSettings());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function openClearOld() {
    // The previous implementation kept `let days = 7` in a closure and never
    // reset it on re-open, leading to surprises (the next dialog would still
    // hold the previous edit). useState here is the canonical fix.
    let days = 7;
    const computeBefore = (d: number) =>
      new Date(Date.now() - d * 24 * 60 * 60 * 1000).toLocaleDateString();
    const cutoffEl = (initialDays: number) => (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t("clearOld.cutoff", { date: computeBefore(initialDays) })}
      </Typography.Text>
    );
    const ConfirmBody = () => {
      const [d, setD] = useState(7);
      return (
        <div style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 6 }}>{t("clearOld.label")}</div>
          <InputNumber
            min={1}
            max={3650}
            value={d}
            onChange={(v) => {
              const next = (v ?? 7) as number;
              setD(next);
              days = next;
            }}
            style={{ width: 120 }}
          />
          <div style={{ marginTop: 6 }}>{cutoffEl(d)}</div>
        </div>
      );
    };
    modal.confirm({
      title: t("clearOld.title"),
      icon: <DeleteOutlined />,
      content: <ConfirmBody />,
      afterClose: () => {
        days = 7;
      },
      onOk: async () => {
        const before = Date.now() - days * 24 * 60 * 60 * 1000;
        try {
          const r = await api.deleteLogsBefore(before);
          messageApi.success(t("clearOld.removed", { count: r.removed }));
          await load();
        } catch (err) {
          setError((err as Error).message);
        }
      },
    });
  }

  function exportCsv() {
    if (logs.length === 0) {
      messageApi.warning(t("export.empty"));
      return;
    }
    const headers = [
      "id",
      "ts",
      "provider_id",
      "client_model",
      "upstream_model",
      "endpoint",
      "status_code",
      "duration_ms",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "cached_tokens",
      "tool_call_count",
      "stream",
      "error_code",
      "error_snippet",
    ];
    const lines = [headers.join(",")];
    for (const row of logs) {
      lines.push(
        headers
          .map((h) => csvEscape((row as unknown as Record<string, unknown>)[h]))
          .join(",")
      );
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mimo2codex-logs-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const columns: ColumnsType<LogRow> = useMemo(
    () => [
      {
        title: t("columns.ts"),
        dataIndex: "ts",
        key: "ts",
        render: (ts: number) => new Date(ts).toLocaleString(),
        width: 180,
      },
      {
        title: t("columns.provider"),
        dataIndex: "provider_id",
        key: "provider_id",
        render: (v: string) => <Tag>{v}</Tag>,
        width: 110,
      },
      {
        title: t("columns.clientModel"),
        dataIndex: "client_model",
        key: "client_model",
        render: (v: string) => <code>{v}</code>,
      },
      {
        title: t("columns.upstreamModel"),
        dataIndex: "upstream_model",
        key: "upstream_model",
        render: (v: string) => <code>{v}</code>,
      },
      {
        title: t("columns.endpoint"),
        dataIndex: "endpoint",
        key: "endpoint",
        render: (v: string) => <code>{v}</code>,
      },
      {
        title: t("columns.status"),
        key: "status",
        render: (_, row) => (
          <Tag color={row.status_code >= 400 ? "error" : "success"}>
            {row.status_code}
            {row.stream ? ` · ${t("stream")}` : ""}
          </Tag>
        ),
        width: 130,
      },
      {
        title: t("columns.promptTokens"),
        dataIndex: "prompt_tokens",
        key: "prompt_tokens",
        align: "right",
        render: (v: number | null) => v ?? "—",
      },
      {
        title: t("columns.completionTokens"),
        dataIndex: "completion_tokens",
        key: "completion_tokens",
        align: "right",
        render: (v: number | null) => v ?? "—",
      },
      {
        title: t("columns.totalTokens"),
        dataIndex: "total_tokens",
        key: "total_tokens",
        align: "right",
        render: (v: number | null) => v ?? "—",
      },
      {
        title: t("columns.tools"),
        dataIndex: "tool_call_count",
        key: "tool_call_count",
        align: "right",
        render: (v: number | null) => (v && v > 0 ? v : "—"),
        width: 70,
      },
      {
        title: t("columns.duration"),
        dataIndex: "duration_ms",
        key: "duration_ms",
        align: "right",
        render: (v: number) => `${v} ms`,
        width: 100,
      },
      {
        title: t("columns.error"),
        key: "error",
        render: (_, row) => {
          if (!row.error_code && !row.error_snippet) return null;
          const text = `${row.error_code ?? ""}${
            row.error_snippet ? `: ${row.error_snippet}` : ""
          }`;
          return (
            <Tooltip title={row.error_snippet ?? ""}>
              <span
                style={{
                  display: "inline-block",
                  maxWidth: 280,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  verticalAlign: "bottom",
                }}
              >
                <code>{text}</code>
              </span>
            </Tooltip>
          );
        },
      },
    ],
    [t]
  );

  return (
    <>
      {msgCtx}
      {modalCtx}
      <Typography.Title level={2} style={{ marginTop: 0 }}>
        {t("title")}
      </Typography.Title>

      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      <Card>
        <div ref={filterRef}>
          <Form
            layout="inline"
            style={{
              marginBottom: 12,
              rowGap: 8,
              columnGap: 8,
              flexWrap: "wrap",
            }}
          >
            <Form.Item
              label={t("filter.providerLabel")}
              style={{ marginRight: 0 }}
            >
              <Select
                value={provider}
                style={{ minWidth: 180 }}
                onChange={(v) => {
                  setProvider(v);
                  setPage(0);
                }}
                options={[
                  { value: "", label: t("filter.all") },
                  ...providers.map((p) => ({
                    value: p.id,
                    label: p.display_name,
                  })),
                ]}
              />
            </Form.Item>
            <Form.Item
              label={t("filter.modelLabel")}
              style={{ marginRight: 0 }}
            >
              <Input
                placeholder={t("filter.modelPlaceholder")}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setPage(0);
                }}
                allowClear
                style={{ width: 200 }}
              />
            </Form.Item>
            <Form.Item
              label={t("filter.statusLabel")}
              style={{ marginRight: 0 }}
            >
              <Segmented<StatusFilter>
                value={statusFilter}
                onChange={(v) => {
                  setStatusFilter(v);
                  setPage(0);
                }}
                options={[
                  { value: "all", label: t("filter.status.all") },
                  { value: "ok", label: t("filter.status.ok") },
                  { value: "error", label: t("filter.status.error") },
                ]}
              />
            </Form.Item>
            <Form.Item style={{ marginRight: 0, marginLeft: "auto" }}>
              <span ref={actionsRef}>
                <Space>
                  <Button icon={<ReloadOutlined />} onClick={() => void load()}>
                    {t("action.refresh")}
                  </Button>
                  <Button
                    icon={<SettingOutlined />}
                    onClick={() => void openLogSettings()}
                    loading={logSettingsLoading}
                  >
                    {t("action.storage")}
                  </Button>
                  <Button icon={<DownloadOutlined />} onClick={exportCsv}>
                    {t("action.exportCsv")}
                  </Button>
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    onClick={openClearOld}
                  >
                    {t("action.clearOld")}
                  </Button>
                </Space>
              </span>
            </Form.Item>
          </Form>
        </div>

        {loading && logs.length === 0 ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <div ref={tableRef}>
            <Table<LogRow>
              rowKey="id"
              dataSource={logs}
              columns={columns}
              loading={loading}
              size="middle"
              expandedRowKeys={expandedRowKeys}
              onExpandedRowsChange={(keys) =>
                setExpandedRowKeys(keys.map((k) => Number(k)))
              }
              pagination={{
                current: page + 1,
                pageSize: PAGE_SIZE,
                onChange: (p) => setPage(p - 1),
                showSizeChanger: false,
                // Total is unknown server-side; show a hasNextPage-style pager
                total:
                  page * PAGE_SIZE +
                  logs.length +
                  (logs.length === PAGE_SIZE ? PAGE_SIZE : 0),
              }}
              locale={{ emptyText: <Empty description={t("empty")} /> }}
              expandable={{
                onExpand: (expanded, row) => {
                  if (expanded) void loadDetail(row.id);
                },
                expandedRowRender: (row) => {
                  const detail = details[row.id];
                  if (!detail) {
                    return (
                      <Typography.Text type="secondary">
                        {detailLoading.has(row.id)
                          ? t("expand.loading")
                          : t("expand.empty")}
                      </Typography.Text>
                    );
                  }
                  const mode = detailMode[row.id] ?? "structured";
                  return (
                    <Space
                      direction="vertical"
                      style={{ width: "100%" }}
                      size={12}
                    >
                      <Segmented<"structured" | "raw">
                        size="small"
                        value={mode}
                        options={[
                          {
                            value: "structured",
                            label: t("expand.modeStructured"),
                          },
                          { value: "raw", label: t("expand.modeRaw") },
                        ]}
                        onChange={(v) =>
                          setDetailMode((prev) => ({ ...prev, [row.id]: v }))
                        }
                      />
                      {mode === "structured" ? (
                        <StructuredDetail detail={detail} t={t} />
                      ) : (
                        <>
                          <BodyBlock
                            title={t("expand.requestBody")}
                            body={detail.request_body}
                            t={t}
                          />
                          <BodyBlock
                            title={t("expand.responseBody")}
                            body={detail.response_body}
                            t={t}
                          />
                        </>
                      )}
                    </Space>
                  );
                },
              }}
            />
          </div>
        )}
      </Card>

      <PageTour
        pageKey="logs"
        steps={[
          {
            target: filterRef,
            title: tTour("logs.s1.title"),
            description: tTour("logs.s1.desc"),
          },
          {
            target: actionsRef,
            title: tTour("logs.s2.title"),
            description: tTour("logs.s2.desc"),
          },
          {
            target: tableRef,
            title: tTour("logs.s3.title"),
            description: tTour("logs.s3.desc"),
          },
        ]}
      />
      <Modal
        title={t("storage.title")}
        open={logSettingsOpen}
        onCancel={() => setLogSettingsOpen(false)}
        onOk={() => void saveLogSettings()}
        destroyOnClose
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          {logSettings &&
          (logSettings.bodyModeCliOverride !== null ||
            logSettings.retentionDaysCliOverrideActive) ? (
            <Alert type="info" showIcon message={t("storage.cliOverride")} />
          ) : null}
          <Form
            form={logSettingsForm}
            layout="vertical"
            initialValues={{ bodyMode: "full", retentionDays: null }}
          >
            <Form.Item label={t("storage.bodyMode.label")} name="bodyMode">
              <Select
                disabled={logSettings?.bodyModeCliOverride !== null}
                options={[
                  { value: "full", label: t("storage.bodyMode.full") },
                  {
                    value: "errors-only",
                    label: t("storage.bodyMode.errorsOnly"),
                  },
                  { value: "off", label: t("storage.bodyMode.off") },
                ]}
              />
            </Form.Item>
            <Form.Item
              label={t("storage.retention.label")}
              name="retentionDays"
              extra={t("storage.retention.help")}
            >
              <InputNumber
                min={1}
                max={3650}
                style={{ width: "100%" }}
                disabled={logSettings?.retentionDaysCliOverrideActive}
              />
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </>
  );
}
