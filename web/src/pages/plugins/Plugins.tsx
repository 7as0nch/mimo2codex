import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import {
  DeleteOutlined,
  DownloadOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import {
  api,
  streamPluginAdapterAction,
  type AdapterStatus,
  type BuiltinPluginInfo,
} from "../../api/client";

export function Plugins() {
  const { t } = useTranslation("plugins");
  const [messageApi, msgCtx] = message.useMessage();
  const [plugins, setPlugins] = useState<BuiltinPluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.plugins();
      setPlugins(resp.plugins);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function toggle(plugin: BuiltinPluginInfo, enabled: boolean) {
    setSavingId(plugin.id);
    setError(null);
    try {
      const resp = await api.setPluginEnabled(plugin.id, enabled);
      setPlugins((prev) => prev.map((p) => (p.id === plugin.id ? resp.plugin : p)));
      messageApi.success(enabled ? t("msg.enabled") : t("msg.disabled"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {msgCtx}
      <Space align="start" style={{ width: "100%", justifyContent: "space-between" }}>
        <div>
          <Typography.Title level={2} style={{ marginBottom: 4 }}>
            {t("title")}
          </Typography.Title>
          <Typography.Text type="secondary">{t("subtitle")}</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
          {t("refresh")}
        </Button>
      </Space>

      <Alert type="info" showIcon message={t("notice.title")} description={t("notice.desc")} />
      {error && <Alert type="error" showIcon message={error} />}

      {plugins.map((plugin) => (
        <Card
          key={plugin.id}
          loading={loading}
          title={
            <Space wrap>
              <span>{plugin.name}</span>
              <Tag color="blue">{t(`category.${plugin.category}`)}</Tag>
              {plugin.enabled ? (
                <Tag color="green">{t("status.enabled")}</Tag>
              ) : (
                <Tag>{t("status.disabled")}</Tag>
              )}
              {plugin.locked && <Tag color="gold">{t("status.envLocked")}</Tag>}
              {!plugin.installed && <Tag color="red">{t("status.missing")}</Tag>}
            </Space>
          }
          extra={
            <Switch
              checked={plugin.enabled}
              disabled={plugin.locked || !plugin.installed}
              loading={savingId === plugin.id}
              onChange={(checked) => toggle(plugin, checked)}
            />
          }
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              {plugin.description}
            </Typography.Paragraph>

            {plugin.locked && (
              <Alert
                type="warning"
                showIcon
                message={t("envLocked.title", { envKey: plugin.envKey })}
                description={t("envLocked.desc", {
                  value: plugin.envOverride ? t("status.enabled") : t("status.disabled"),
                })}
              />
            )}
            {plugin.enabled && !plugin.configEnabled && (
              <Alert
                type="warning"
                showIcon
                message={t("configMismatch.title")}
                description={t("configMismatch.desc")}
              />
            )}

            <Descriptions size="small" bordered column={{ xs: 1, sm: 1, md: 2 }}>
              <Descriptions.Item label={t("fields.id")}>
                <code>{plugin.id}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t("fields.mcpServer")}>
                <code>{plugin.mcpServerName}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t("fields.configPath")} span={2}>
                <code>{plugin.configPath}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t("fields.serverPath")} span={2}>
                <code>{plugin.serverPath}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t("fields.envKey")}>
                <code>{plugin.envKey}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t("fields.configEnabled")}>
                {plugin.configEnabled ? (
                  <Tag color="green">{t("yes")}</Tag>
                ) : (
                  <Tag>{t("no")}</Tag>
                )}
              </Descriptions.Item>
            </Descriptions>

            {plugin.category === "computer-use" && <AdapterPanel pluginId={plugin.id} />}

            <Alert
              type="success"
              showIcon
              message={t("usage.title")}
              description={
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  {t("usage.desc")}
                  <br />
                  <code>{t("usage.prompt")}</code>
                </Typography.Paragraph>
              }
            />
          </Space>
        </Card>
      ))}
    </Space>
  );
}

interface AdapterModalState {
  action: "install" | "uninstall";
  lines: string[];
  running: boolean;
  result: "ok" | "fail" | null;
  configChanged?: boolean;
}

// Detect / download+build / uninstall the desktop backend (Trope CUA) for a
// computer-use plugin. Probing runs the plugin's --doctor server-side; install
// and uninstall stream the child process output live into a modal log.
function AdapterPanel({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation("plugins");
  const [status, setStatus] = useState<AdapterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<AdapterModalState | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const probe = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.pluginAdapter(pluginId);
      setStatus(r.adapter);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [pluginId]);

  useEffect(() => {
    void probe();
  }, [probe]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [modal?.lines]);

  async function run(action: "install" | "uninstall") {
    const ac = new AbortController();
    abortRef.current = ac;
    setModal({ action, lines: [], running: true, result: null });
    try {
      await streamPluginAdapterAction(
        pluginId,
        action,
        {
          onLog: (line) =>
            setModal((m) => (m ? { ...m, lines: [...m.lines, line] } : m)),
          onDone: (d) =>
            setModal((m) =>
              m ? { ...m, running: false, result: d.ok ? "ok" : "fail", configChanged: d.configChanged } : m
            ),
          onError: (msg) =>
            setModal((m) =>
              m ? { ...m, lines: [...m.lines, msg], running: false, result: "fail" } : m
            ),
        },
        ac.signal
      );
    } catch (e) {
      setModal((m) =>
        m ? { ...m, lines: [...m.lines, (e as Error).message], running: false, result: "fail" } : m
      );
    } finally {
      abortRef.current = null;
      void probe();
    }
  }

  function closeModal() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setModal(null);
    void probe();
  }

  const installed = status?.adapterOk === true;
  const unsupported = status?.installPlan?.ok === false || status?.code === "unsupported_platform";
  const prereqs = status?.installPlan?.prerequisites ?? [];
  const exePath = status?.command?.[0] ?? null;

  return (
    <Card type="inner" size="small" title={t("adapter.title")}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Typography.Text type="secondary">{t("adapter.desc")}</Typography.Text>

        {loading ? (
          <Space>
            <Spin size="small" />
            <span>{t("adapter.detecting")}</span>
          </Space>
        ) : (
          <>
            <Space wrap>
              {installed ? (
                <Tag color="green">{t("adapter.installed")}</Tag>
              ) : (
                <Tag color="red">{t("adapter.notInstalled")}</Tag>
              )}
              {status?.backend && (
                <span>
                  {t("adapter.backend")}: <code>{status.backend}</code>
                </span>
              )}
            </Space>

            {installed && exePath && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t("adapter.path")}: <code>{exePath}</code>
              </Typography.Text>
            )}

            {!installed && prereqs.length > 0 && (
              <Space wrap size={4}>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{t("adapter.prereqTitle")}:</span>
                {prereqs.map((p) => (
                  <Tag key={p}>{p}</Tag>
                ))}
              </Space>
            )}

            {unsupported && <Alert type="warning" showIcon message={t("adapter.unsupported")} />}

            <Space wrap>
              {installed ? (
                <>
                  <Button icon={<DownloadOutlined />} onClick={() => run("install")}>
                    {t("adapter.reinstall")}
                  </Button>
                  <Popconfirm
                    title={t("adapter.confirmUninstall")}
                    okText={t("adapter.uninstall")}
                    cancelText={t("adapter.cancel")}
                    onConfirm={() => run("uninstall")}
                  >
                    <Button danger icon={<DeleteOutlined />}>
                      {t("adapter.uninstall")}
                    </Button>
                  </Popconfirm>
                </>
              ) : (
                <Button
                  type="primary"
                  icon={<DownloadOutlined />}
                  disabled={unsupported}
                  onClick={() => run("install")}
                >
                  {t("adapter.install")}
                </Button>
              )}
              <Button icon={<ReloadOutlined />} onClick={() => void probe()}>
                {t("adapter.recheck")}
              </Button>
            </Space>
          </>
        )}
      </Space>

      <Modal
        open={modal !== null}
        title={
          modal?.action === "uninstall"
            ? t("adapter.uninstallModalTitle")
            : t("adapter.installModalTitle")
        }
        onCancel={closeModal}
        maskClosable={false}
        footer={
          <Button onClick={closeModal} disabled={modal?.running}>
            {modal?.running ? t("adapter.running") : t("adapter.close")}
          </Button>
        }
        width={680}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <div
            ref={logRef}
            style={{
              maxHeight: 340,
              overflow: "auto",
              background: "rgba(0,0,0,0.04)",
              borderRadius: 6,
              padding: "8px 12px",
              fontFamily: "monospace",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {(modal?.lines ?? []).join("\n") || (modal?.running ? t("adapter.running") : "")}
          </div>
          {modal?.result === "ok" && (
            <Alert
              type="success"
              showIcon
              message={
                modal.action === "uninstall"
                  ? t("adapter.uninstallOk")
                  : t("adapter.installOkRestart")
              }
              description={
                modal.configChanged
                  ? modal.action === "uninstall"
                    ? t("adapter.configCleaned")
                    : t("adapter.configUpdated")
                  : undefined
              }
            />
          )}
          {modal?.result === "fail" && <Alert type="error" showIcon message={t("adapter.failed")} />}
        </Space>
      </Modal>
    </Card>
  );
}
