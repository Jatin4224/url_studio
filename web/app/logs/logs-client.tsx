"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./logs.module.css";
import {
  getStream as useLogStream,
  type LogLevel,
  type LogEvent,
} from "@oneminutelogs/next";

const colors: Record<LogLevel, string> = {
  trace: "text-slate-400",
  debug: "text-violet-400",
  info: "text-sky-400",
  warn: "text-amber-400",
  error: "text-red-400",
  fatal: "text-rose-400",
};

function LogDetails({
  event,
  onClose,
}: {
  event: LogEvent;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState("formatted");
  const [copyStatus, setCopyStatus] = useState("Copy JSON");

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event, null, 2));
      setCopyStatus("Copied!");
    } catch {
      setCopyStatus("Copy failed");
    }
  }

  return (
    <dialog
      ref={dialog}
      className={styles.modal}
      aria-labelledby="log-details-title"
      onClose={onClose}
      onClick={(click) => {
        if (click.target === click.currentTarget) {
          const bounds = click.currentTarget.getBoundingClientRect();
          if (
            click.clientX < bounds.left ||
            click.clientX > bounds.right ||
            click.clientY < bounds.top ||
            click.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <div className={styles.modalHeader}>
        <h2 id="log-details-title">Log Details</h2>
        <button className={styles.copyButton} onClick={copyJson}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M9 5H6a2 2 0 0 0-2 2v13h16V7a2 2 0 0 0-2-2h-3" />
            <rect x="9" y="2" width="6" height="5" rx="1" />
          </svg>
          <span role="status">{copyStatus}</span>
        </button>
        <button
          className={styles.closeButton}
          aria-label="Close log details"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Log detail format"
      >
        {["formatted", "raw"].map((value) => (
          <button
            key={value}
            id={`tab-${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls="log-detail-panel"
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(key) => {
              if (
                ["ArrowLeft", "ArrowRight", "Home", "End"].includes(key.key)
              ) {
                key.preventDefault();
                const next =
                  key.key === "Home"
                    ? "formatted"
                    : key.key === "End"
                      ? "raw"
                      : tab === "formatted"
                        ? "raw"
                        : "formatted";
                setTab(next);
                document.getElementById(`tab-${next}`)?.focus();
              }
            }}
          >
            {value === "formatted" ? "Formatted" : "Raw JSON"}
          </button>
        ))}
      </div>
      <div
        id="log-detail-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className={styles.modalContent}
        tabIndex={0}
      >
        {tab === "raw" ? (
          <pre className={styles.json}>{JSON.stringify(event, null, 2)}</pre>
        ) : (
          <>
            <dl className={styles.fields}>
              <div>
                <dt>Timestamp</dt>
                <dd>{new Date(event.timestamp).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Level</dt>
                <dd className={colors[event.level]}>{event.level}</dd>
              </div>
              <div>
                <dt>Service</dt>
                <dd>{event.serviceName || "—"}</dd>
              </div>
              <div>
                <dt>Event</dt>
                <dd>{event.eventName || "—"}</dd>
              </div>
            </dl>
            <h3 className={styles.fieldLabel}>Message</h3>
            <p className={styles.message}>{event.message}</p>
            <h3 className={styles.fieldLabel}>Attributes</h3>
            <pre className={styles.json}>
              {JSON.stringify(event.attributes ?? {}, null, 2)}
            </pre>
          </>
        )}
      </div>
    </dialog>
  );
}

function LiveTail() {
  const { data, isLoading, connected, error } = useLogStream();
  const [selected, setSelected] = useState<LogEvent | null>(null);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const logs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return data.filter((event) => {
      const project =
        event.resource?.["oml.project.name"] ??
        event.attributes?.["oml.project.name"];
      return (
        project === "OneMinute Studio" &&
        (level === "all" || event.level === level) &&
        (!query ||
          `${event.message} ${event.serviceName} ${event.eventName ?? ""} ${JSON.stringify(event.attributes)}`
            .toLowerCase()
            .includes(query))
      );
    });
  }, [data, search, level]);

  useEffect(() => {
    if (autoScroll && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  return (
    <>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          Search logs
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Message, service, event, or attributes…"
            className="mt-2 block w-full rounded-lg border border-white/15 bg-white/5 p-3 text-sm text-neutral-100"
          />
        </label>
        <label className={styles.filter}>
          Level
          <select
            value={level}
            onChange={(event) => setLevel(event.target.value)}
            className="mt-2 block rounded-lg border border-white/15 bg-[#181a1d] p-3 text-sm text-neutral-100"
          >
            <option value="all">All levels</option>
            {Object.keys(colors).map((value) => (
              <option key={value} value={value}>
                {value.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.statusbar}>
        <span role="status">
          <span
            className={
              error
                ? "text-amber-400"
                : connected && !isLoading
                  ? "text-emerald-400"
                  : "text-neutral-400"
            }
          >
            ●{" "}
            {error
              ? "Connection interrupted"
              : isLoading
                ? "Connecting…"
                : connected
                  ? "Live"
                  : "Disconnected"}
          </span>{" "}
          · {logs.length} events shown
        </span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
          />
          Auto-scroll
        </label>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          Unable to stream logs. Check the server’s OML configuration, then
          reconnect.
        </p>
      )}
      <div className={styles.consoleHeading}>
        <span>EVENT STREAM</span>
        <span>TIME / LEVEL / SERVICE / MESSAGE</span>
      </div>
      <div
        ref={viewport}
        tabIndex={0}
        aria-label="Live log tail"
        className={styles.viewport}
      >
        {logs.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.signal} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <h2>
              {error
                ? "Stream unavailable"
                : isLoading
                  ? "Opening the stream"
                  : search || level !== "all"
                    ? "No matching events"
                    : "Listening for activity"}
            </h2>
            <p>
              {error
                ? "Reconnect to try again."
                : isLoading
                  ? "Connecting to OneMinute Logs…"
                  : search || level !== "all"
                    ? "Try another search or log level."
                    : "New events from OneMinute Studio will appear here as they arrive."}
            </p>
            {!error && !isLoading && !search && level === "all" && (
              <span className={styles.emptyHint}>
                STREAM OPEN <span>·</span> WAITING FOR EVENTS
              </span>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {logs.map((event, index) => (
              <li key={`${event.id}-${index}`}>
                <button
                  type="button"
                  className={styles.logButton}
                  onClick={() => setSelected(event)}
                  aria-label={`View log: ${event.message}`}
                >
                  <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-neutral-500">
                    <time dateTime={event.timestamp}>
                      {new Date(event.timestamp).toLocaleString()}
                    </time>
                    <span className={colors[event.level]}>
                      [{event.level.toUpperCase()}]
                    </span>
                    <span className="text-neutral-300">
                      {event.serviceName}
                    </span>
                    {event.environment && <span>{event.environment}</span>}
                    {event.eventName && <span>{event.eventName}</span>}
                  </div>
                  <p className="whitespace-pre-wrap wrap-break-word text-neutral-200">
                    {event.message}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected && (
        <LogDetails event={selected} onClose={() => setSelected(null)} />
      )}
      <div className={styles.consoleFooter}>
        <span>
          OneMinute Studio <span aria-hidden="true">/</span> All services
        </span>
        <span>Latest 5,000 events · Powered by OneMinute Logs</span>
      </div>
    </>
  );
}

export default function LogsPage({ expires }: { expires: number }) {
  useEffect(() => {
    const timer = setTimeout(() => window.location.reload(), Math.max(0, expires - Date.now()));
    return () => clearTimeout(timer);
  }, [expires]);
  const [session, setSession] = useState(0);
  return (
    <div className={styles.shell}>
      <main className={styles.main}>
        <div className={styles.titlebar}>
          <div>
            <p className={styles.eyebrow}>OBSERVABILITY</p>
            <h1>
              Live logs<span className={styles.titleDot}>.</span>
            </h1>
            <p className={styles.description}>
              A real-time view of what’s happening in your studio.
            </p>
          </div>
          <button
            onClick={() => setSession((value) => value + 1)}
            className={styles.reconnect}
          >
            <span aria-hidden="true">↻</span> Reconnect
          </button>
        </div>
        <section className={styles.console} aria-label="Project logs">
          <LiveTail key={session} />
        </section>
      </main>
    </div>
  );
}
