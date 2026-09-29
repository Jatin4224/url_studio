"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./logs.module.css";

export default function PasswordGate() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const password = new FormData(event.currentTarget).get("password");
    try {
      const response = await fetch("/api/admin-login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
      });
      if (response.ok) { window.location.reload(); return; }
      setError((await response.json()).error || "Unable to sign in.");
    } catch { setError("Unable to connect. Please try again."); }
    setPending(false);
  }

  return <div className={styles.shell}>
    <dialog ref={dialog} className={styles.modal} aria-labelledby="admin-title" onCancel={(event) => event.preventDefault()}>
      <form onSubmit={unlock} className={styles.passwordForm}>
        <h2 id="admin-title">Admin access</h2>
        <p>Enter your password to access logs for 24 hours.</p>
        <label htmlFor="admin-password">Password</label>
        <input id="admin-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} autoFocus />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={pending}>{pending ? "Checking…" : "Unlock logs"}</button>
      </form>
    </dialog>
  </div>;
}
