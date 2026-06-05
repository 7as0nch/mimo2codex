import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
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
  CheckCircleFilled,
  DeleteOutlined,
  DesktopOutlined,
  DownloadOutlined,
  HeartOutlined,
  ReloadOutlined,
  RightOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import {
  api,
  streamPluginAdapterAction,
  type AdapterStatus,
  type BuiltinPluginInfo,
} from "../../api/client";

// docweb (public docs site) — where users submit plugin contributions and read
// the built-in plugin catalog.
const DOCWEB = "https://mimodoc.chengj.online";
const DOCWEB_PLUGINS = `${DOCWEB}/plugins`;
const DOCWEB_SUBMIT = `${DOCWEB}/ideas/new`;

export function Plugins() {
  const { t } = useTranslation("plugins");
  const [messageApi, msgCtx] = message.useMessage();
  const [plugins, setPlugins] = useState<BuiltinPluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const selected = plugins.find((p) => p.id === selectedId) ?? null;

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

      {loading && plugins.length === 0 ? (
        <Spin />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 16,
          }}
        >
          {plugins.map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} onOpen={() => setSelectedId(plugin.id)} />
          ))}
          <ContributeCard />
        </div>
      )}

      <PluginDrawer
        plugin={selected}
        savingId={savingId}
        onToggle={toggle}
        onClose={() => setSelectedId(null)}
      />
    </Space>
  );
}

// 48px rounded icon tile used on the marketplace cards.
const iconTile = (bg: string, color: string): React.CSSProperties => ({
  width: 48,
  height: 48,
  flexShrink: 0,
  borderRadius: 12,
  background: bg,
  color,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 22,
});

// Compact marketplace card. Clicking anywhere opens the detail drawer.
function PluginCard({ plugin, onOpen }: { plugin: BuiltinPluginInfo; onOpen: () => void }) {
  const { t } = useTranslation("plugins");
  return (
    <Card hoverable onClick={onOpen} styles={{ body: { padding: 16 } }} style={{ height: "100%" }}>
      <Space align="start" style={{ width: "100%" }} size={12}>
        <div style={iconTile("linear-gradient(135deg,#6366f1,#4f46e5)", "#fff")}>
          <DesktopOutlined />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space style={{ width: "100%", justifyContent: "space-between" }} align="start">
            <Typography.Text strong style={{ fontSize: 15 }}>
              {plugin.name}
            </Typography.Text>
            {plugin.enabled && <CheckCircleFilled style={{ color: "#52c41a", fontSize: 16 }} />}
          </Space>
          <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: "6px 0" }}>
            {plugin.description}
          </Typography.Paragraph>
          <Space wrap size={4}>
            <Tag color="blue">{t(`category.${plugin.category}`)}</Tag>
            {plugin.enabled ? (
              <Tag color="green">{t("status.enabled")}</Tag>
            ) : (
              <Tag>{t("status.disabled")}</Tag>
            )}
            {plugin.locked && <Tag color="gold">{t("status.envLocked")}</Tag>}
            {!plugin.installed && <Tag color="red">{t("status.missing")}</Tag>}
          </Space>
        </div>
      </Space>
    </Card>
  );
}

// Dashed "submit a plugin" card → opens the docweb contribution page.
function ContributeCard() {
  const { t } = useTranslation("plugins");
  return (
    <Card
      hoverable
      onClick={() => window.open(DOCWEB_SUBMIT, "_blank", "noopener")}
      styles={{ body: { padding: 16 } }}
      style={{ height: "100%", borderStyle: "dashed" }}
    >
      <Space align="start" style={{ width: "100%" }} size={12}>
        <div style={iconTile("#fff0f6", "#eb2f96")}>
          <HeartOutlined />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong style={{ fontSize: 15 }}>
            {t("contribute.title")}
          </Typography.Text>
          <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: "6px 0" }}>
            {t("contribute.desc")}
          </Typography.Paragraph>
          <Button type="link" style={{ padding: 0, height: "auto" }}>
            {t("contribute.cta")} <RightOutlined />
          </Button>
        </div>
      </Space>
    </Card>
  );
}

// Detail drawer: enable toggle, config descriptions, the adapter panel, and a
// link to the docweb plugin catalog.
function PluginDrawer({
  plugin,
  savingId,
  onToggle,
  onClose,
}: {
  plugin: BuiltinPluginInfo | null;
  savingId: string | null;
  onToggle: (plugin: BuiltinPluginInfo, enabled: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("plugins");
  const navigate = useNavigate();
  return (
    <Drawer
      open={!!plugin}
      onClose={onClose}
      width={560}
      title={plugin ? <Space><DesktopOutlined />{plugin.name}</Space> : ""}
    >
      {plugin && (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <Space wrap>
              <Tag color="blue">{t(`category.${plugin.category}`)}</Tag>
              {plugin.enabled ? (
                <Tag color="green">{t("status.enabled")}</Tag>
              ) : (
                <Tag>{t("status.disabled")}</Tag>
              )}
              {plugin.locked && <Tag color="gold">{t("status.envLocked")}</Tag>}
              {!plugin.installed && <Tag color="red">{t("status.missing")}</Tag>}
            </Space>
            <Space>
              <span style={{ fontSize: 13, opacity: 0.7 }}>{t("enableLabel")}</span>
              <Switch
                checked={plugin.enabled}
                disabled={plugin.locked || !plugin.installed}
                loading={savingId === plugin.id}
                onChange={(checked) => onToggle(plugin, checked)}
              />
            </Space>
          </div>

          <Typography.Paragraph style={{ marginBottom: 0 }}>{plugin.description}</Typography.Paragraph>

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

          {plugin.category === "computer-use" && (
            <Button
              icon={<DesktopOutlined />}
              onClick={() => {
                onClose();
                navigate("/computer-use");
              }}
            >
              {t("openMonitor")}
            </Button>
          )}

          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label={t("fields.id")}>
              <code>{plugin.id}</code>
            </Descriptions.Item>
            <Descriptions.Item label={t("fields.mcpServer")}>
              <code>{plugin.mcpServerName}</code>
            </Descriptions.Item>
            <Descriptions.Item label={t("fields.configPath")}>
              <code>{plugin.configPath}</code>
            </Descriptions.Item>
            <Descriptions.Item label={t("fields.serverPath")}>
              <code>{plugin.serverPath}</code>
            </Descriptions.Item>
            <Descriptions.Item label={t("fields.envKey")}>
              <code>{plugin.envKey}</code>
            </Descriptions.Item>
            <Descriptions.Item label={t("fields.configEnabled")}>
              {plugin.configEnabled ? <Tag color="green">{t("yes")}</Tag> : <Tag>{t("no")}</Tag>}
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

          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            <a href={DOCWEB_PLUGINS} target="_blank" rel="noreferrer">
              {t("learnMore")} <RightOutlined />
            </a>
          </Typography.Paragraph>
        </Space>
      )}
    </Drawer>
  );
}

interface AdapterModalState {
  action: "install" | "uninstall";
  lines: string[];
  running: boolean;
  result: "ok" | "fail" | null;
  configChanged?: boolean;
}

// Detect / install / uninstall the desktop-control dependencies (nut.js, and
// the optional Electron glowing-cursor overlay) for a computer-use plugin.
// Probing runs the plugin's --doctor server-side; install and uninstall stream
// the child process (npm) output live into a modal log.
function AdapterPanel({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation("plugins");
  const [status, setStatus] = useState<AdapterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<AdapterModalState | null>(null);
  const [withElectron, setWithElectron] = useState(false);
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

  async function run(action: "install" | "uninstall", electron?: boolean) {
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
        ac.signal,
        { electron }
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
  const electronReady = status?.overlay?.available === true;

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

            {!installed && prereqs.length > 0 && (
              <Space wrap size={4}>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{t("adapter.prereqTitle")}:</span>
                {prereqs.map((p) => (
                  <Tag key={p}>{p}</Tag>
                ))}
              </Space>
            )}

            {unsupported && <Alert type="warning" showIcon message={t("adapter.unsupported")} />}

            {!installed && (
              <Checkbox checked={withElectron} onChange={(e) => setWithElectron(e.target.checked)}>
                {t("adapter.withElectronLabel")}
              </Checkbox>
            )}

            <Space wrap>
              {installed ? (
                <Button icon={<DownloadOutlined />} onClick={() => run("install", false)}>
                  {t("adapter.reinstall")}
                </Button>
              ) : (
                <Button
                  type="primary"
                  icon={<DownloadOutlined />}
                  disabled={unsupported}
                  onClick={() => run("install", withElectron)}
                >
                  {t("adapter.install")}
                </Button>
              )}
              <Button icon={<ReloadOutlined />} onClick={() => void probe()}>
                {t("adapter.recheck")}
              </Button>
            </Space>

            {/* Optional Electron glowing-cursor overlay runtime. */}
            {installed && (
              <Card type="inner" size="small" title={<Space><ThunderboltOutlined />{t("adapter.overlayTitle")}</Space>}>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Space wrap>
                    {electronReady ? (
                      <Tag color="green">{t("adapter.overlayInstalled")}</Tag>
                    ) : (
                      <Tag>{t("adapter.overlayNotInstalled")}</Tag>
                    )}
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("adapter.overlayDesc")}
                  </Typography.Text>
                  <Space wrap>
                    {electronReady ? (
                      <Popconfirm
                        title={t("adapter.confirmRemoveElectron")}
                        okText={t("adapter.removeElectron")}
                        cancelText={t("adapter.cancel")}
                        onConfirm={() => run("uninstall")}
                      >
                        <Button danger size="small" icon={<DeleteOutlined />}>
                          {t("adapter.removeElectron")}
                        </Button>
                      </Popconfirm>
                    ) : (
                      <Button size="small" icon={<DownloadOutlined />} onClick={() => run("install", true)}>
                        {t("adapter.downloadElectron")}
                      </Button>
                    )}
                  </Space>
                </Space>
              </Card>
            )}
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
            />
          )}
          {modal?.result === "fail" && <Alert type="error" showIcon message={t("adapter.failed")} />}
        </Space>
      </Modal>
    </Card>
  );
}
