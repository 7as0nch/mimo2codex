import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Input,
  Modal,
  Space,
  Switch,
  Tabs,
  Typography,
} from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import {
  api,
  type CodexBackupPair,
  type CodexState,
  type CodexTarget,
  type CodexTargetsResponse,
} from "../../api/client";
import { SetupSnippets } from "../../components/SetupSnippets";
import { PageTour } from "../../components/PageTour";
import type { Busy, ProbeState } from "./types";
import { promptRestartCodex } from "./restartCodex";
import { ProviderBlock } from "./ProviderBlock";
import { RuntimeOverrideCard } from "./RuntimeOverrideCard";
import { BackupCard } from "./BackupCard";
import { HistoryPanel } from "./HistoryPanel";
import { useAuth } from "../../contexts/AuthContext";

export function CodexEnable() {
  const { t } = useTranslation("codexEnable");
  const { t: tCommon } = useTranslation("common");
  const { t: tTour } = useTranslation("tour");
  const { authMode } = useAuth();
  const isServerMode = authMode === "on";
  const [modal, modalCtx] = Modal.useModal();
  const prereqRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const testAllRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<CodexState | null>(null);
  const [targetsResp, setTargetsResp] = useState<CodexTargetsResponse | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [testingAll, setTestingAll] = useState<boolean>(false);
  // thinking.disabled setting：admin UI 控制的全局"关思考"开关。null = 加载中。
  // CLI flag (--disable-thinking / env) 优先于该设置 —— 当 cliOverridden 为 true 时
  // 显示一行提示并禁用 Switch（避免 UI 误导用户以为自己能改）。
  const [thinkingDisabled, setThinkingDisabled] = useState<boolean | null>(
    null
  );
  const [thinkingCliOverridden, setThinkingCliOverridden] =
    useState<boolean>(false);
  const [thinkingSaving, setThinkingSaving] = useState<boolean>(false);
  // thinking.forceHighEffort：独立开关。Codex 没传 reasoning.effort 时是否兜底注 "high"。
  // 与 thinkingDisabled 不同维度；关思考时被忽略。
  const [forceHighEffort, setForceHighEffort] = useState<boolean | null>(null);
  const [forceHighEffortSaving, setForceHighEffortSaving] =
    useState<boolean>(false);
  // visionFallback：多模态 fallback 开关 + 目标模型。null = 加载中。
  const [visionFallbackEnabled, setVisionFallbackEnabled] = useState<boolean | null>(null);
  const [visionFallbackModel, setVisionFallbackModel] = useState<string>("mimo-v2.5");
  const [visionFallbackSaving, setVisionFallbackSaving] = useState<boolean>(false);

  async function doProbe(target: CodexTarget) {
    const key = `${target.providerId}::${target.modelId}`;
    setProbes((prev) => ({ ...prev, [key]: { running: true } }));
    try {
      const result = await api.probeModel({
        providerId: target.providerId,
        modelId: target.modelId,
      });
      setProbes((prev) => ({ ...prev, [key]: { running: false, result } }));
    } catch (err) {
      setProbes((prev) => ({
        ...prev,
        [key]: {
          running: false,
          result: {
            ok: false,
            latencyMs: 0,
            error: {
              code: "request_failed",
              message: (err as Error).message,
            },
          },
        },
      }));
    }
  }

  async function load() {
    try {
      setError(null);
      const [s, ts, think, vf] = await Promise.all([
        api.codexState(),
        api.codexTargets(),
        api.thinkingState().catch(() => null), // 老后端没此端点时降级
        api.visionFallback().catch(() => null), // 老后端没此端点时降级
      ]);
      setState(s);
      setTargetsResp(ts);
      if (think) {
        setThinkingDisabled(think.effective);
        setThinkingCliOverridden(think.cliOverride !== null);
        setForceHighEffort(think.forceHighEffort);
      }
      if (vf) {
        setVisionFallbackEnabled(vf.enabled);
        setVisionFallbackModel(vf.model);
      } else {
        setVisionFallbackEnabled(false);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function doToggleThinking(disabled: boolean): Promise<void> {
    setThinkingSaving(true);
    try {
      await api.setThinkingDisabled(disabled);
      setThinkingDisabled(disabled);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setThinkingSaving(false);
    }
  }

  async function doToggleForceHighEffort(enabled: boolean): Promise<void> {
    setForceHighEffortSaving(true);
    try {
      await api.setForceHighEffort(enabled);
      setForceHighEffort(enabled);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setForceHighEffortSaving(false);
    }
  }

  async function doToggleVisionFallback(enabled: boolean): Promise<void> {
    setVisionFallbackSaving(true);
    try {
      await api.setVisionFallback({ enabled });
      setVisionFallbackEnabled(enabled);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setVisionFallbackSaving(false);
    }
  }

  async function doSetVisionFallbackModel(model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed || trimmed === visionFallbackModel) return;
    setVisionFallbackSaving(true);
    try {
      await api.setVisionFallback({ model: trimmed });
      setVisionFallbackModel(trimmed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setVisionFallbackSaving(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function rowKey(target: CodexTarget): string {
    return `${target.providerId}::${target.modelId}`;
  }

  async function doApply(target: CodexTarget) {
    setBusy({ kind: "apply", key: rowKey(target) });
    setError(null);
    setSuccess(null);
    try {
      const resp = await api.codexApply({
        providerId: target.providerId,
        modelId: target.modelId,
      });
      let note = "";
      if (resp.preserved) {
        note = t("msg.appliedPreserved", { ts: resp.backupTs });
      } else if (resp.authBackup || resp.tomlBackup) {
        note = t("msg.appliedBackedUp", { ts: resp.backupTs });
      }
      setSuccess(
        t("msg.applied", {
          provider: target.providerDisplayName,
          model: target.modelId,
          note,
        })
      );
      await load();
      // Config only takes effect on Codex reload — offer to do it right now.
      promptRestartCodex(modal, t, (m) =>
        m.type === "success" ? setSuccess(m.text) : setError(m.text)
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function onApplyClick(target: CodexTarget) {
    if (state?.authJsonOwner === "external") {
      modal.confirm({
        width: 540,
        title: t("confirm.applyTitle"),
        okButtonProps: { danger: true },
        okText: t("confirm.applyConfirmBtn"),
        cancelText: tCommon("cancel"),
        content: (
          <div>
            <p>{t("confirm.applyP1")}</p>
            <p>{t("confirm.applyP2")}</p>
            <p>
              {t("confirm.applyTarget")}:{" "}
              <strong>{target.providerDisplayName}</strong> /{" "}
              <code>{target.modelId}</code>
            </p>
          </div>
        ),
        onOk: () => doApply(target),
      });
      return;
    }
    void doApply(target);
  }

  async function doOverride(target: CodexTarget) {
    setBusy({ kind: "override", key: rowKey(target) });
    setError(null);
    setSuccess(null);
    try {
      await api.setActiveOverride({
        providerId: target.providerId,
        modelId: target.modelId,
      });
      setSuccess(
        t("msg.overrideSet", {
          provider: target.providerDisplayName,
          model: target.modelId,
        })
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function doTestAll() {
    if (!targetsResp) return;
    setTestingAll(true);
    setError(null);
    const enabledTargets = targetsResp.targets.filter((tgt) => tgt.hasKey);
    await Promise.all(enabledTargets.map((target) => doProbe(target)));
    setTestingAll(false);
  }

  async function doClearOverride() {
    setBusy({ kind: "clear", key: "" });
    setError(null);
    setSuccess(null);
    try {
      await api.clearActiveOverride();
      setSuccess(t("msg.overrideCleared"));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function onRestoreClick(b: CodexBackupPair) {
    const missing: string[] = [];
    if (!b.authBackup) missing.push(t("confirm.restoreMissingAuth"));
    if (!b.tomlBackup) missing.push(t("confirm.restoreMissingToml"));
    const detail =
      missing.length > 0
        ? `\n${t("confirm.restoreMissingPrefix")}${missing.join("; ")}.`
        : "";
    modal.confirm({
      title: t("confirm.restoreTitle", { ts: b.ts }),
      content: (
        <div style={{ whiteSpace: "pre-wrap" }}>
          {t("confirm.restoreBody") + detail}
        </div>
      ),
      okText: t("backup.restore"),
      cancelText: tCommon("cancel"),
      onOk: async () => {
        setBusy({ kind: "restore", key: String(b.ts) });
        setError(null);
        setSuccess(null);
        try {
          await api.codexRestore(b.ts);
          setSuccess(t("msg.restored", { ts: b.ts }));
          await load();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(null);
        }
      },
    });
  }

  function onDeleteBackupClick(b: CodexBackupPair) {
    const text = b.preserved
      ? t("confirm.deletePreserved")
      : t("confirm.deleteNormal", { ts: b.ts });
    modal.confirm({
      title: t("backup.delete"),
      content: <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>,
      okButtonProps: { danger: true },
      okText: t("backup.delete"),
      cancelText: tCommon("cancel"),
      onOk: async () => {
        setBusy({ kind: "delete-backup", key: String(b.ts) });
        setError(null);
        setSuccess(null);
        try {
          await api.deleteCodexBackup(b.ts, b.preserved);
          setSuccess(t("msg.backupDeleted", { ts: b.ts }));
          await load();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(null);
        }
      },
    });
  }

  const grouped = useMemo(() => {
    if (!targetsResp) return new Map<string, CodexTarget[]>();
    const m = new Map<string, CodexTarget[]>();
    for (const target of targetsResp.targets) {
      const arr = m.get(target.providerId) ?? [];
      arr.push(target);
      m.set(target.providerId, arr);
    }
    return m;
  }, [targetsResp]);

  return (
    <>
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
      {success && (
        <Alert
          type="success"
          showIcon
          message={success}
          closable
          onClose={() => setSuccess(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      <div ref={prereqRef}>
        <Collapse
          style={{ marginBottom: 16 }}
          items={[
            {
              key: "prereq",
              label: (
                <span>
                  <strong>{t("prereq.title")}</strong>{" "}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("prereq.subtitle")}
                  </Typography.Text>
                </span>
              ),
              children: (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    {t("intro")}
                  </Typography.Paragraph>
                  <Alert
                    type="info"
                    showIcon
                    description={
                      <Space direction="vertical" size={6}>
                        <Trans i18nKey="modesInfo.applyFile" ns="codexEnable">
                          <strong>placeholder</strong>placeholder
                          <strong>placeholder</strong>placeholder
                        </Trans>
                        <Trans i18nKey="modesInfo.runtimeOverride" ns="codexEnable">
                          <strong>placeholder</strong>placeholder
                          <strong>placeholder</strong>placeholder
                        </Trans>
                      </Space>
                    }
                    message={null}
                  />
                  <SetupSnippets />
                </Space>
              ),
            },
          ]}
        />
      </div>

      <div ref={tabsRef}>
        <Tabs
          defaultActiveKey="targets"
          items={[
            {
              key: "targets",
              label: t("tabs.targets"),
              children: state ? (
                <>
                  <Space style={{ marginBottom: 12 }}>
                    <Button
                      ref={testAllRef}
                      size="small"
                      icon={<ThunderboltOutlined />}
                      loading={testingAll}
                      onClick={() => void doTestAll()}
                      disabled={
                        !targetsResp || targetsResp.targets.length === 0
                      }
                    >
                      {testingAll
                        ? t("targets.testAllBusy")
                        : t("targets.testAll")}
                    </Button>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t("targets.testAllHint")}
                    </Typography.Text>
                  </Space>
                  {state.authJsonOwner === "external" && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={t("targets.externalWarn")}
                    />
                  )}
                  {targetsResp && targetsResp.targets.length === 0 ? (
                    <Typography.Text type="secondary">
                      {t("targets.empty")}
                    </Typography.Text>
                  ) : (
                    Array.from(grouped.entries()).map(([providerId, list]) => (
                      <ProviderBlock
                        key={providerId}
                        providerDisplayName={list[0].providerDisplayName}
                        targets={list}
                        busy={busy}
                        probes={probes}
                        onApply={onApplyClick}
                        onOverride={doOverride}
                        onProbe={doProbe}
                      />
                    ))
                  )}
                </>
              ) : null,
            },
            {
              key: "thinking",
              label: t("tabs.thinking"),
              children: (
                <>
                  {thinkingDisabled !== null && (
                    <Card
                      size="small"
                      title={t("thinking.title")}
                      style={{ marginBottom: 12 }}
                    >
                      <Space wrap>
                        <Switch
                          size="small"
                          checked={!thinkingDisabled}
                          loading={thinkingSaving}
                          disabled={thinkingCliOverridden}
                          onChange={(enabled) =>
                            void doToggleThinking(!enabled)
                          }
                          checkedChildren={t("thinking.switchOn")}
                          unCheckedChildren={t("thinking.switchOff")}
                        />
                        <span>
                          {thinkingDisabled
                            ? t("thinking.statusOff")
                            : t("thinking.statusOn")}
                        </span>
                        <span
                          style={{
                            marginLeft: 16,
                            opacity: thinkingDisabled ? 0.4 : 1,
                          }}
                        >
                          ·
                        </span>
                        <Switch
                          size="small"
                          checked={!!forceHighEffort}
                          loading={forceHighEffortSaving}
                          disabled={!!thinkingDisabled || thinkingCliOverridden}
                          onChange={(v) => void doToggleForceHighEffort(v)}
                          checkedChildren={t("thinking.forceHighOn")}
                          unCheckedChildren={t("thinking.forceHighOff")}
                        />
                        <span style={{ opacity: thinkingDisabled ? 0.4 : 1 }}>
                          {t("thinking.forceHighLabel")}
                        </span>
                      </Space>
                      <Typography.Paragraph
                        type="secondary"
                        style={{
                          fontSize: 12,
                          marginTop: 8,
                          marginBottom: 0,
                        }}
                      >
                        {t("thinking.hint")}
                      </Typography.Paragraph>
                      {forceHighEffort && !thinkingDisabled && (
                        <Alert
                          type="warning"
                          showIcon
                          message={t("thinking.forceHighSideEffect")}
                          style={{ marginTop: 8 }}
                        />
                      )}
                      {thinkingCliOverridden && (
                        <Alert
                          type="warning"
                          showIcon
                          message={t("thinking.cliOverride")}
                          style={{ marginTop: 8 }}
                        />
                      )}
                    </Card>
                  )}
                  {visionFallbackEnabled !== null && (
                    <Card
                      size="small"
                      title={t("visionFallback.title")}
                      style={{ marginBottom: 12 }}
                    >
                      <Alert
                        type="info"
                        showIcon
                        message={t("visionFallback.scopeNote")}
                        style={{ marginBottom: 8 }}
                      />
                      <Space wrap>
                        <Switch
                          size="small"
                          checked={!!visionFallbackEnabled}
                          loading={visionFallbackSaving}
                          onChange={(enabled) =>
                            void doToggleVisionFallback(enabled)
                          }
                          checkedChildren={t("thinking.switchOn")}
                          unCheckedChildren={t("thinking.switchOff")}
                        />
                        <span>
                          {visionFallbackEnabled
                            ? t("visionFallback.statusOn")
                            : t("visionFallback.statusOff")}
                        </span>
                      </Space>
                      <div style={{ marginTop: 8 }}>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12 }}
                        >
                          {t("visionFallback.modelLabel")}
                        </Typography.Text>
                        <Input
                          size="small"
                          value={visionFallbackModel}
                          onChange={(e) =>
                            setVisionFallbackModel(e.target.value)
                          }
                          disabled={!visionFallbackEnabled}
                          placeholder={t("visionFallback.modelPlaceholder")}
                          onBlur={(e) =>
                            void doSetVisionFallbackModel(e.target.value)
                          }
                          onPressEnter={() =>
                            void doSetVisionFallbackModel(visionFallbackModel)
                          }
                          style={{ width: 240, marginTop: 4, marginLeft: 4 }}
                        />
                      </div>
                      <Typography.Paragraph
                        type="secondary"
                        style={{
                          fontSize: 12,
                          marginTop: 8,
                          marginBottom: 0,
                        }}
                      >
                        {t("visionFallback.hint")}
                      </Typography.Paragraph>
                    </Card>
                  )}
                  {state && (
                    <RuntimeOverrideCard
                      state={state}
                      busy={busy}
                      onClear={doClearOverride}
                    />
                  )}
                </>
              ),
            },
            {
              key: "backups",
              label: t("tabs.backups"),
              children: state ? (
                <BackupCard
                  state={state}
                  busy={busy}
                  onRestore={onRestoreClick}
                  onDelete={onDeleteBackupClick}
                />
              ) : null,
            },
            // History tab tracks codex-apply / restore / import audit trail —
            // only meaningful in Docker auth deployments where multiple operators
            // share the proxy. Hide in local single-user mode.
            ...(isServerMode
              ? [
                  {
                    key: "history",
                    label: t("tabs.history", { defaultValue: "History" }),
                    children: <HistoryPanel />,
                  },
                ]
              : []),
          ]}
        />
      </div>

      <PageTour
        pageKey="codex"
        steps={[
          {
            target: prereqRef,
            title: tTour("codex.s2.title"),
            description: tTour("codex.s2.desc"),
          },
          {
            target: tabsRef,
            title: tTour("codex.s3.title"),
            description: tTour("codex.s3.desc"),
          },
          {
            target: testAllRef,
            title: tTour("codex.s4.title"),
            description: tTour("codex.s4.desc"),
          },
        ]}
      />
    </>
  );
}
