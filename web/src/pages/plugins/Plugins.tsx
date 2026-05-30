import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api, type BuiltinPluginInfo } from "../../api/client";

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
