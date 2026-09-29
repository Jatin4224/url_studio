"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";

type Job = {
  id: string;
  url: string;
  status: "running" | "completed" | "failed";
  step: number;
  progress: number;
  scenesCompleted: number;
  totalScenes: number;
  error?: string;
  finalVideoUrl?: string;
};
const steps = [
  "Understanding website",
  "Planning presentation",
  "Capturing product scenes",
  "Creating cinematic scenes",
  "Composing presentation",
];
const savedJobKey = "url-studio-job";
const genericFailure = "Could not connect to the studio. Please try again.";

// job.url is whatever the backend echoed back, so it may not parse.
// A bad value must not take the whole view down mid-render.
function hostnameOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function Arrow() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 12h14m-6-6 6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A miniature of this page's own interface, used as the source material in the preview compositions.
function MiniSite({ className = "" }: { className?: string }) {
  return (
    <div className={`mini-site ${className}`} aria-hidden="true">
      <div className="mini-bar">
        <span className="mini-mark">
          <i />
          <i />
          <i />
        </span>
        <b />
        <b className="short" />
      </div>
      <div className="mini-eyebrow" />
      <div className="mini-heading">
        <b />
        <b className="accent" />
        <b />
      </div>
      <div className="mini-input">
        <span />
        <em />
      </div>
      <div className="mini-columns">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

function FocusInput({ className = "" }: { className?: string }) {
  return (
    <div className={`focus-input ${className}`} aria-hidden="true">
      <span>↗</span>
      <span>https://yourproduct.com</span>
      <b>Generate Presentation →</b>
    </div>
  );
}

// The preview's soundtrack: a fixed, music-like waveform above the player's progress bar.
const soundtrack = Array.from({ length: 72 }, (_, i) =>
  Math.round(18 + 78 * Math.abs(Math.sin(i * 0.83) * Math.cos(i * 0.29 + 1))),
);

const scenes = [
  {
    number: "01",
    title: "Understand",
    text: "We read the real structure, content and visual identity of your website.",
    time: "00:00",
  },
  {
    number: "02",
    title: "Direct",
    text: "The product story becomes a sequence of intentional scenes.",
    time: "00:06",
  },
  {
    number: "03",
    title: "Capture",
    text: "The right interface sections and product details become visual references.",
    time: "00:14",
  },
  {
    number: "04",
    title: "Render",
    text: "Each scene becomes cinematic motion and one finished presentation.",
    time: "00:22",
  },
];

export default function Page() {
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Both forms share this handler, so the error is tied to the input it came
  // from — otherwise one failed submit renders the message twice on the page.
  const [errorAt, setErrorAt] = useState("");
  const [connection, setConnection] = useState("");

  // Restore the last accepted job without submitting another paid generation.
  useEffect(() => {
    const id = localStorage.getItem(savedJobKey);
    if (!id) return;
    const controller = new AbortController();
    fetch(`/api/presentations/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 404) {
          localStorage.removeItem(savedJobKey);
          return;
        }
        if (!response.ok)
          throw new Error(
            "Could not reconnect to your presentation. Please refresh to try again.",
          );
        setJob(await response.json());
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, []);

  const id = job?.id;
  const running = job?.status === "running";
  useEffect(() => {
    if (!id || !running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(`/api/presentations/${id}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const result = await response.json().catch(() => ({}));
        if (response.status === 404) {
          setJob(
            (previous) =>
              previous && {
                ...previous,
                status: "failed",
                error: result.error,
              },
          );
          localStorage.removeItem(savedJobKey);
          return;
        }
        if (!response.ok) throw new Error(result.error);
        setJob(result);
        setConnection("");
        if (result.status !== "running") return;
      } catch {
        if (controller.signal.aborted) return;
        setConnection(
          "Connection interrupted. Reconnecting to your presentation…",
        );
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2_000);
    }
    timer = setTimeout(poll, 2_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, running]);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const url = new FormData(form).get("url");
    setSubmitting(true);
    setError("");
    setErrorAt(form.querySelector("input")?.id ?? "");
    try {
      const response = await fetch("/api/presentations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      // A missing or unreachable backend answers with an HTML error page, not JSON.
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? genericFailure);
      setJob(result);
      localStorage.setItem(savedJobKey, result.id);
      window.scrollTo({ top: 0 });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : genericFailure);
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    localStorage.removeItem(savedJobKey);
    setJob(null);
    setError("");
    setErrorAt("");
    setConnection("");
  }

  function urlForm(inputId: string, label: string) {
    const suffix = inputId === "website-url" ? "" : `-${inputId}`;
    return (
      <form
        className="generation-form"
        onSubmit={generate}
        aria-busy={submitting}
      >
        <label htmlFor={inputId}>{label}</label>
        <div className="input-row">
          <span className="link-icon" aria-hidden="true">
            ↗
          </span>
          <input
            id={inputId}
            name="url"
            type="url"
            required
            maxLength={2048}
            placeholder="https://yourproduct.com"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            readOnly={submitting}
            aria-describedby={`form-note${suffix} form-error${suffix}`}
          />
          <button
            className="primary-button"
            disabled={submitting}
            type="submit"
          >
            {submitting ? "Opening the studio…" : "Generate Presentation"}
            <Arrow />
          </button>
        </div>
        <p id={`form-note${suffix}`} className="form-note">
          Made from your real website <span>·</span> Ready-to-share MP4{" "}
          <span>·</span> No editing required
        </p>
        {error && errorAt === inputId && (
          <p id={`form-error${suffix}`} className="error-message" role="alert">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <div className="studio-shell">
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="URL Studio home">
          <span className="brand-symbol" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          URL <span className="wordmark-light">Studio</span>
        </Link>
        <span className="header-note">
          <span className="tiny-dot" /> A new perspective on your product
        </span>
      </header>

      <main>
        {!job ? (
          <>
            <section className="landing">
              <p className="eyebrow">
                <span className="short-line" /> FROM WEBSITE TO SPOTLIGHT
              </p>
              <h1>
                Turn any website into a<br className="desktop-break" />{" "}
                <em>cinematic</em> product
                <br className="desktop-break" /> presentation.
              </h1>
              <p className="intro">
                Your interface. Your identity. A whole new way to see it.
                <br />
                Create a short product film from a single link.
              </p>
              {urlForm("website-url", "THE STARTING POINT")}
              <div className="process-overview" aria-label="How it works">
                <div>
                  <span className="process-number">01 /</span>
                  <h2>Share your website.</h2>
                  <p>
                    We find the product, the details,
                    <br />
                    and the story worth showing.
                  </p>
                </div>
                <div>
                  <span className="process-number">02 /</span>
                  <h2>See it in motion.</h2>
                  <p>
                    Your actual interface becomes
                    <br />a sequence of cinematic scenes.
                  </p>
                </div>
                <div>
                  <span className="process-number">03 /</span>
                  <h2>Make an impression.</h2>
                  <p>
                    One finished presentation.
                    <br />
                    Download it. Put it to work.
                  </p>
                </div>
              </div>
            </section>

            <section className="chapter" aria-labelledby="transformation-title">
              <div className="chapter-head">
                <p className="eyebrow">
                  <span className="short-line" /> THE TRANSFORMATION
                </p>
                <h2 id="transformation-title" className="chapter-title">
                  Your interface.
                  <br />A new <em>perspective.</em>
                </h2>
                <p className="intro">
                  URL Studio uses your real product interface and turns it
                  into a cinematic sequence without replacing its identity.
                </p>
              </div>
              <figure className="stage transform-stage">
                <span className="stage-label top-left">
                  SCENE 01 <span>/</span> THE PRODUCT
                </span>
                <span className="stage-label top-right">
                  16:9 <span>·</span> 1920 × 1080
                </span>
                <span className="stage-label bottom-left">00:00:03:12</span>
                <span className="stage-label bottom-right">
                  URL STUDIO
                </span>
                <div className="source-panel">
                  <MiniSite />
                  <p className="stage-caption">
                    <span>A</span> Real website
                  </p>
                </div>
                <div className="stage-arrow" aria-hidden="true">
                  <i />
                </div>
                <div className="film-panel">
                  <div className="film-plane">
                    <MiniSite className="layer-back" />
                    <MiniSite className="layer-front" />
                    <FocusInput className="layer-focus" />
                  </div>
                  <p className="stage-caption">
                    <span>B</span> Cinematic product film
                  </p>
                </div>
                <figcaption className="sr-only">
                  Your real website interface, reframed as a cinematic product
                  film.
                </figcaption>
              </figure>
            </section>

            <section className="chapter" aria-labelledby="process-title">
              <div className="chapter-head split">
                <div>
                  <p className="eyebrow">
                    <span className="short-line" /> FROM LINK TO FILM
                  </p>
                  <h2 id="process-title" className="chapter-title">
                    One link.
                    <br />
                    From page to <em>cinematic</em> film.
                  </h2>
                </div>
                <p className="chapter-aside">
                  A storyboard, directed
                  <br />
                  from your own website.
                </p>
              </div>
              <ol className="storyboard">
                {scenes.map((scene) => (
                  <li key={scene.number} className="shot">
                    <div className="shot-meta">
                      <span>SC {scene.number}</span>
                      <span>{scene.time}</span>
                    </div>
                    <div
                      className={`shot-frame art-${scene.title.toLowerCase()}`}
                      aria-hidden="true"
                    >
                      {scene.number === "01" && (
                        <div className="wire">
                          <i data-tag="nav" />
                          <i data-tag="h1" />
                          <i data-tag="form" />
                          <i data-tag="section" />
                        </div>
                      )}
                      {scene.number === "02" && (
                        <div className="sequence">
                          {["Hero", "Product", "Features", "Closing"].map(
                            (name, index) => (
                              <p key={name}>
                                <span>0{index + 1}</span>
                                {name}
                                <i
                                  style={{
                                    width: `${[38, 62, 48, 30][index]}%`,
                                  }}
                                />
                              </p>
                            ),
                          )}
                        </div>
                      )}
                      {scene.number === "03" && (
                        <>
                          <MiniSite />
                          <span className="crop" data-tag="REF 02" />
                        </>
                      )}
                      {scene.number === "04" && (
                        <>
                          <div className="render-plane">
                            <MiniSite />
                          </div>
                          <span className="render-bar">
                            <i />
                          </span>
                        </>
                      )}
                    </div>
                    <h3>
                      <span>{scene.number}</span>
                      {scene.title}
                    </h3>
                    <p>{scene.text}</p>
                  </li>
                ))}
              </ol>
            </section>

            <section className="chapter" aria-labelledby="principles-title">
              <div className="chapter-head">
                <p className="eyebrow">
                  <span className="short-line" /> BUILT AROUND YOUR PRODUCT
                </p>
                <h2 id="principles-title" className="chapter-title">
                  Still your interface.
                  <br />
                  Just <em>impossible</em> to ignore.
                </h2>
              </div>
              <div className="principles">
                <article className="principle-lead">
                  <div className="stage direction-stage" aria-hidden="true">
                    <div className="thirds">
                      <i />
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className="direction-plane">
                      <MiniSite />
                      <FocusInput className="direction-focus" />
                    </div>
                    <span className="stage-label top-left">
                      CAMERA <span>/</span> SLOW PUSH-IN
                    </span>
                    <span className="stage-label bottom-right">
                      FOCUS <span>·</span> PRIMARY ACTION
                    </span>
                  </div>
                  <span className="process-number">02 /</span>
                  <h3>Cinematic direction</h3>
                  <p>
                    Depth, camera movement, focus and composition give the
                    interface a new perspective.
                  </p>
                </article>
                <div className="principle-list">
                  {[
                    [
                      "01",
                      "Real interface",
                      "Your actual website remains the visual source.",
                    ],
                    [
                      "03",
                      "Contextual motion",
                      "Interface elements receive motion appropriate to what they represent.",
                    ],
                    [
                      "04",
                      "Ready to share",
                      "The scenes become one finished product presentation.",
                    ],
                  ].map(([number, title, text]) => (
                    <article key={number}>
                      <span className="process-number">{number} /</span>
                      <h3>{title}</h3>
                      <p>{text}</p>
                    </article>
                  ))}
                </div>
              </div>
            </section>

            <section className="chapter" aria-labelledby="final-cut-title">
              <div className="chapter-head">
                <p className="eyebrow">
                  <span className="short-line" /> THE FINAL CUT
                </p>
                <h2 id="final-cut-title" className="chapter-title">
                  Every interface
                  <br />
                  <em>tells a story.</em>
                </h2>
              </div>
              <figure className="stage cut-stage">
                <span className="stage-label top-left">
                  <span className="tiny-dot" /> url-studio-presentation.mp4
                </span>
                <span className="stage-label top-right">
                  SCENE 02 <span>/</span> 04
                </span>
                <div className="cut-plane">
                  <MiniSite className="layer-back" />
                  <MiniSite />
                  <FocusInput className="cut-focus" />
                </div>
                <div className="lower-third">
                  <span>02 — The product</span>
                  <strong>Your interface, in motion.</strong>
                </div>
                <div className="cut-wave" aria-hidden="true">
                  {soundtrack.map((level, index) => (
                    <i
                      key={index}
                      className={
                        index < soundtrack.length * 0.32 ? "played" : ""
                      }
                      style={{ height: `${level}%` }}
                    />
                  ))}
                </div>
                <div className="cut-controls" aria-hidden="true">
                  <span>▶</span>
                  <i>
                    <b />
                  </i>
                  <span>00:09 / 00:28</span>
                </div>
                <figcaption className="sr-only">
                  A finished URL Studio presentation: one continuous film
                  built from the sections of a website.
                </figcaption>
              </figure>
              <ol className="timeline" aria-label="Presentation scenes">
                {["Hero", "Product", "Features", "Closing"].map(
                  (name, index) => (
                    <li key={name} className={index === 1 ? "current" : ""}>
                      <div
                        className={`thumb thumb-${index + 1}`}
                        aria-hidden="true"
                      >
                        <MiniSite />
                      </div>
                      <span>
                        {scenes[index].number} <b>{name}</b>
                      </span>
                      <span>{scenes[index].time}</span>
                    </li>
                  ),
                )}
              </ol>
            </section>

            <section className="finale" aria-labelledby="finale-title">
              <p className="eyebrow">
                <span className="short-line" /> THE LAST SCENE
              </p>
              <h2 id="finale-title" className="finale-title">
                Give your product
                <br />a <em>new perspective.</em>
              </h2>
              <p className="intro">One link. One cinematic presentation.</p>
              {urlForm("finale-url", "YOUR PRODUCT, IN MOTION")}
              <p className="fade-out" aria-hidden="true">
                <span>END OF SEQUENCE</span>
                <i />
                <span>FADE OUT</span>
              </p>
            </section>
          </>
        ) : job.status === "completed" ? (
          <section className="result-section">
            <p className="eyebrow">
              <span className="tiny-dot" /> THE FINAL CUT
            </p>
            <h1>
              Your presentation
              <br />
              is <em>ready.</em>
            </h1>
            <p className="intro">
              A new perspective on {hostnameOf(job.url)}.
            </p>
            <div className="video-frame">
              <video
                controls
                playsInline
                preload="metadata"
                src={job.finalVideoUrl}
                aria-label="Your generated presentation"
                onError={() =>
                  setError(
                    "The video could not be loaded. Try downloading the MP4 below.",
                  )
                }
              />
            </div>
            <div className="result-actions">
              <a
                className="primary-button"
                href={`${job.finalVideoUrl}?download=1`}
                download="url-studio-presentation.mp4"
              >
                Download MP4
                <Arrow />
              </a>
              <button className="text-button" onClick={reset}>
                Create another presentation <span>↗</span>
              </button>
            </div>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <p className="result-meta">
              1920 × 1080 <span>·</span> 16:9 <span>·</span> Made with URL Studio
            </p>
          </section>
        ) : (
          <section className="progress-section">
            <p className="eyebrow">
              <span className={`tiny-dot ${running ? "pulsing" : ""}`} />{" "}
              {running ? "STUDIO IN SESSION" : "LET’S TAKE ANOTHER LOOK"}
            </p>
            <h1>
              {running ? (
                <>
                  Creating your
                  <br />
                  <em>presentation.</em>
                </>
              ) : (
                <>
                  We couldn’t finish
                  <br />
                  this <em>presentation.</em>
                </>
              )}
            </h1>
            <p className="intro">{hostnameOf(job.url)}</p>
            <div className="progress-panel" aria-live="polite">
              <div className="progress-heading">
                <span>
                  {running
                    ? "A little direction. A little time."
                    : "Generation stopped"}
                </span>
                <span>{job.progress}%</span>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Presentation progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={job.progress}
              >
                <div style={{ width: `${job.progress}%` }} />
              </div>
              <ol className="steps">
                {steps.map((step, index) => (
                  <li
                    key={step}
                    className={
                      index < job.step
                        ? "done"
                        : index === job.step
                          ? "active"
                          : "pending"
                    }
                  >
                    <span
                      className={`step-symbol ${index === job.step && running ? "spinning" : ""}`}
                      aria-hidden="true"
                    >
                      {index < job.step
                        ? "✓"
                        : index === job.step && !running
                          ? "!"
                          : ""}
                    </span>
                    <span>{step}</span>
                    {index === 3 && job.totalScenes > 0 && (
                      <span className="scene-count">
                        {job.scenesCompleted} / {job.totalScenes}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
            {running ? (
              <p className="progress-note" role="status">
                {connection ||
                  "Good things take a few minutes. We’ll bring the finished film right here."}
              </p>
            ) : (
              <div className="failure-detail">
                <p className="error-message" role="alert">
                  {job.error ??
                    "The studio stopped before the presentation was finished."}
                </p>
                <p className="reference">Reference: {job.id}</p>
                <button className="primary-button" onClick={reset}>
                  Try another website
                  <Arrow />
                </button>
              </div>
            )}
          </section>
        )}
      </main>
      <footer>
        <span>One link. A different dimension.</span>
        <span>
          URL Studio <span className="footer-mark">/</span> 2026
        </span>
      </footer>
    </div>
  );
}
