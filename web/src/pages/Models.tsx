import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Input,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  DeleteOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import {
  api,
  type ModelRow,
  type ProviderInfo,
} from "../api/client";
import { PageTour } from "../components/PageTour";

// Page is scoped to built-in providers — generic providers manage their
// models through Providers Form's `models[]` list. Anything outside this set
// is filtered out of the segmented switcher.
const BUILTIN_PROVIDER_IDS = new Set(["mimo", "deepseek"]);

export function Models() {
  const { t } = useTranslation("models");
  const { t: tTour } = useTranslation("tour");
  const [modal, modalCtx] = Modal.useModal();
  const segmentedRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const addFormRef = useRef<HTMLDivElement>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [active, setActive] = useState<string>("mimo");
  const [models, setModels] = useState<ModelRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newModel, setNewModel] = useState({ upstream_id: "", display_name: "" });
  const [savingId, setSavingId] = useState<number | null>(null);

  async function load() {
    try {
      setError(null);
      const [p, m] = await Promise.all([
        api.providers(),
        api.modelsFor(active),
      ]);
      setProviders(p.providers);
      setModels(m.models);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function addModel() {
    if (!newModel.upstream_id) return;
    try {
      await api.createModel(active, newModel);
      setNewModel({ upstream_id: "", display_name: "" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function removeModel(row: ModelRow) {
    modal.confirm({
      title: t("deleteConfirm"),
      content: (
        <div>
          <code>{row.upstream_id}</code>
          {row.display_name ? <span> ({row.display_name})</span> : null}
        </div>
      ),
      icon: <DeleteOutlined />,
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.deleteModel(row.id);
          await load();
        } catch (err) {
          setError((err as Error).message);
        }
      },
    });
  }

  async function setDeprecatedDate(row: ModelRow, value: string | null) {
    if (row.is_builtin) return;
    setSavingId(row.id);
    try {
      await api.patchModel(row.id, { deprecated_after: value });
      await load();
      message.success(t("list.deprecated.saved"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  const modelColumns: ColumnsType<ModelRow> = useMemo(
    () => [
      {
        title: t("list.columns.upstreamId"),
        dataIndex: "upstream_id",
        key: "upstream_id",
        render: (v: string) => <code>{v}</code>,
      },
      {
        title: t("list.columns.displayName"),
        dataIndex: "display_name",
        key: "display_name",
        render: (v: string | null) => v ?? "—",
      },
      {
        title: t("list.columns.capabilities"),
        key: "capabilities",
        render: (_, m) => (
          <Space size={4} wrap>
            {m.supports_images ? <Tag>{t("list.capability.vision")}</Tag> : null}
            {m.supports_reasoning ? (
              <Tag>{t("list.capability.reasoning")}</Tag>
            ) : null}
            {m.supports_web_search ? (
              <Tag>{t("list.capability.webSearch")}</Tag>
            ) : null}
          </Space>
        ),
      },
      {
        title: t("list.columns.context"),
        dataIndex: "context_window",
        key: "context_window",
        render: (v: number | null) => v?.toLocaleString() ?? "—",
      },
      {
        title: t("list.columns.reasoningEffort"),
        dataIndex: "reasoning_effort",
        key: "reasoning_effort",
        render: (v: string | null) =>
          v ? (
            <Tag color={v === "max" ? "red" : v === "xhigh" ? "orange" : "blue"}>{v}</Tag>
          ) : "—",
      },
      {
        title: t("list.columns.source"),
        dataIndex: "is_builtin",
        key: "is_builtin",
        render: (v: number) =>
          v ? (
            <Tag>{t("list.source.builtin")}</Tag>
          ) : (
            <Tag color="success">{t("list.source.custom")}</Tag>
          ),
      },
      {
        title: t("list.columns.deprecated"),
        dataIndex: "deprecated_after",
        key: "deprecated_after",
        render: (v: string | null, row) => {
          if (row.is_builtin) {
            return v ? <Tag color="warning">{v}</Tag> : "—";
          }
          return (
            <DatePicker
              size="small"
              value={v ? dayjs(v) : null}
              disabled={savingId === row.id}
              onChange={(d) =>
                void setDeprecatedDate(row, d ? d.format("YYYY-MM-DD") : null)
              }
              placeholder={t("list.deprecated.placeholder")}
              allowClear
              style={{ width: 150 }}
            />
          );
        },
      },
      {
        title: t("list.columns.ops"),
        key: "ops",
        align: "right",
        render: (_, m) =>
          m.is_builtin ? (
            <Tooltip title={t("list.readonly")}>
              <Tag>{t("list.readonly")}</Tag>
            </Tooltip>
          ) : (
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeModel(m)}
            >
              {t("list.columns.ops")}
            </Button>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, savingId]
  );

  return (
    <>
      {modalCtx}
      <Space
        align="start"
        style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}
        wrap
      >
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            {t("title")}
          </Typography.Title>
          <Typography.Text type="secondary">{t("subtitle")}</Typography.Text>
        </div>
        <div ref={segmentedRef}>
          <Segmented<string>
            value={active}
            onChange={setActive}
            options={providers
              .filter((p) => BUILTIN_PROVIDER_IDS.has(p.id))
              .map((p) => ({
                value: p.id,
                label: (
                  <Space>
                    {p.display_name}
                    <Tag color={p.enabled ? "success" : "default"}>
                      {p.enabled
                        ? t("providerStatus.enabled")
                        : t("providerStatus.missingKey")}
                    </Tag>
                  </Space>
                ),
              }))}
          />
        </div>
      </Space>

      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 12 }}
        />
      )}

      <Card
        title={t("list.title")}
        styles={{ body: { padding: 0 } }}
      >
        <div ref={tableRef}>
          <Table<ModelRow>
            rowKey="id"
            dataSource={models}
            columns={modelColumns}
            pagination={false}
            size="middle"
          />
        </div>
        <div
          ref={addFormRef}
          style={{
            padding: "12px 16px",
            borderTop: "1px solid var(--ant-color-border-secondary, #eee)",
          }}
        >
          <Space wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("create.title")}:
            </Typography.Text>
            <Input
              size="small"
              placeholder={t("create.upstreamPlaceholder")}
              value={newModel.upstream_id}
              onChange={(e) =>
                setNewModel({ ...newModel, upstream_id: e.target.value })
              }
              style={{ width: 240 }}
            />
            <Input
              size="small"
              placeholder={t("create.displayNamePlaceholder")}
              value={newModel.display_name}
              onChange={(e) =>
                setNewModel({ ...newModel, display_name: e.target.value })
              }
              style={{ width: 200 }}
            />
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => void addModel()}
              disabled={!newModel.upstream_id}
            >
              {t("create.submit")}
            </Button>
          </Space>
        </div>
      </Card>

      <PageTour
        pageKey="models"
        steps={[
          {
            target: segmentedRef,
            title: tTour("models.s1.title"),
            description: tTour("models.s1.desc"),
          },
          {
            target: tableRef,
            title: tTour("models.s2.title"),
            description: tTour("models.s2.desc"),
          },
          {
            target: addFormRef,
            title: tTour("models.s3.title"),
            description: tTour("models.s3.desc"),
          },
        ]}
      />
    </>
  );
}
