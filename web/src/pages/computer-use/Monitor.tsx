import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Badge, Button, Card, Empty, Space, Tag, Typography } from "antd";
import { AimOutlined, ClearOutlined } from "@ant-design/icons";
import {
  streamComputerUse,
  computerUseFrameUrl,
  type ComputerUseEvent,
} from "../../api/client";

interface FrameState {
  name: string;
  size?: { width: number; height: number };
}

const MAX_LOG = 60;

export function ComputerUseMonitor() {
  const { t } = useTranslation("computeruse");
  const [events, setEvents] = useState<ComputerUseEvent[]>([]);
  const [frame, setFrame] = useState<FrameState | null>(null);
  const [cursor, setCursor] = useState<{ xPct: number; yPct: number } | null>(null);
  const [ripple, setRipple] = useState<{ xPct: number; yPct: number; id: number } | null>(null);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const rippleSeq = useRef(0);

  const handleEvent = useCallback((evt: ComputerUseEvent) => {
    setEvents((prev) => [...prev.slice(-(MAX_LOG - 1)), evt]);
    // Human-takeover: the AI paused because the user moved the mouse. Clears
    // once the AI re-observes (state) or acts again (click).
    if (evt.type === "intervened") setPaused(true);
    else if (evt.type === "state" || evt.type === "click") setPaused(false);
    if (evt.type === "state" && evt.frameName) {
      if (evt.size) sizeRef.current = evt.size;
      setFrame({ name: evt.frameName, size: evt.size ?? sizeRef.current ?? undefined });
    }
    const size = evt.size ?? sizeRef.current;
    if (typeof evt.x === "number" && typeof evt.y === "number" && size && size.width && size.height) {
      const xPct = (evt.x / size.width) * 100;
      const yPct = (evt.y / size.height) * 100;
      setCursor({ xPct, yPct });
      if (evt.type === "click") {
        const id = rippleSeq.current++;
        setRipple({ xPct, yPct, id });
      }
    }
  }, []);

  useEffect(() => {
    let stop = false;
    let ac: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (stop) return;
      ac = new AbortController();
      setConnected(true);
      streamComputerUse(handleEvent, ac.signal)
        .catch(() => {
          /* network/abort — fall through to retry */
        })
        .finally(() => {
          if (stop) return;
          setConnected(false);
          retry = setTimeout(connect, 3000);
        });
    };
    connect();

    return () => {
      stop = true;
      if (ac) ac.abort();
      if (retry) clearTimeout(retry);
    };
  }, [handleEvent]);

  const actionLabel = (evt: ComputerUseEvent): string => {
    switch (evt.type) {
      case "state":
        return t("log.state");
      case "click":
        return t("log.click", {
          x: evt.x ?? "?",
          y: evt.y ?? "?",
          button: evt.button ?? "left",
          dbl: evt.double ? " ×2" : "",
        });
      case "type":
        return t("log.type", { chars: evt.chars ?? 0 });
      case "key":
        return t("log.key", { key: evt.key ?? "" });
      case "scroll":
        return t("log.scroll", { dir: evt.direction ?? "down" });
      case "intervened":
        return t("log.intervened");
      default:
        return evt.type;
    }
  };

  const tagColor = (type: string): string =>
    type === "click" ? "geekblue" : type === "type" ? "purple" : type === "state" ? "cyan" : type === "intervened" ? "volcano" : "default";

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Space align="start" style={{ width: "100%", justifyContent: "space-between" }}>
        <div>
          <Typography.Title level={2} style={{ marginBottom: 4 }}>
            {t("title")}
          </Typography.Title>
          <Typography.Text type="secondary">{t("subtitle")}</Typography.Text>
        </div>
        <Space>
          <Badge status={connected ? "processing" : "default"} text={connected ? t("live") : t("offline")} />
          <Button
            icon={<ClearOutlined />}
            onClick={() => {
              setEvents([]);
              setCursor(null);
              setRipple(null);
            }}
          >
            {t("clear")}
          </Button>
        </Space>
      </Space>

      {paused ? (
        <Alert type="warning" showIcon message={t("paused.title")} description={t("paused.desc")} />
      ) : (
        <Alert type="info" showIcon message={t("notice.title")} description={t("notice.desc")} />
      )}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <Card
          title={t("screen")}
          style={{ flex: "2 1 520px", minWidth: 320 }}
          styles={{ body: { padding: 8 } }}
        >
          {frame ? (
            <div
              style={{
                position: "relative",
                width: "100%",
                background: "#000",
                borderRadius: 6,
                overflow: "hidden",
                lineHeight: 0,
              }}
            >
              <img
                src={computerUseFrameUrl(frame.name)}
                alt="screen"
                style={{ width: "100%", height: "auto", display: "block" }}
              />
              {cursor && (
                <AimOutlined
                  style={{
                    position: "absolute",
                    left: `${cursor.xPct}%`,
                    top: `${cursor.yPct}%`,
                    transform: "translate(-50%, -50%)",
                    color: "#27e0ff",
                    fontSize: 26,
                    filter: "drop-shadow(0 0 6px rgba(39,224,255,0.9))",
                    transition: "left 280ms ease, top 280ms ease",
                    pointerEvents: "none",
                  }}
                />
              )}
              {ripple && (
                <span
                  key={ripple.id}
                  className="cu-ripple"
                  style={{ left: `${ripple.xPct}%`, top: `${ripple.yPct}%` }}
                  onAnimationEnd={() => setRipple(null)}
                />
              )}
            </div>
          ) : (
            <Empty description={t("waiting")} />
          )}
        </Card>

        <Card title={t("activity")} style={{ flex: "1 1 280px", minWidth: 240, maxHeight: 520, overflow: "auto" }}>
          {events.length === 0 ? (
            <Empty description={t("noEvents")} />
          ) : (
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              {[...events].reverse().map((evt, i) => (
                <div key={events.length - i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <Tag color={tagColor(evt.type)} style={{ marginInlineEnd: 0 }}>
                    {evt.type}
                  </Tag>
                  <span style={{ flex: 1, fontSize: 13 }}>{actionLabel(evt)}</span>
                  <span style={{ fontSize: 11, opacity: 0.5 }}>
                    {new Date(evt.ts).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </Space>
          )}
        </Card>
      </div>

      <style>{`
        .cu-ripple {
          position: absolute;
          width: 14px; height: 14px;
          margin: -7px 0 0 -7px;
          border: 3px solid rgba(39,224,255,0.85);
          border-radius: 50%;
          transform: scale(0.4);
          pointer-events: none;
          animation: cu-ripple 540ms ease-out forwards;
        }
        @keyframes cu-ripple {
          to { transform: scale(3.4); opacity: 0; border-width: 1px; }
        }
      `}</style>
    </Space>
  );
}
