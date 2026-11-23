"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { GoogleSignInButton } from "@/components/google-button";
import { Button, CardSkeleton, ErrorBanner, Field, Input, Notice } from "@/components/ui";
import { type ApiError, get, post, setCsrf } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"google" | "password" | null>(null);
  const [returned, setReturned] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // An error from the Google callback arrives as ?error=… (text written by Jonathon's API, shown as plain text).
    setReturned(new URLSearchParams(window.location.search).get("error"));
    get<{ set_up: boolean; auth?: "google" | "password" }>("/setup/status")
      .then((s) => {
        if (!s.set_up) return router.replace("/setup");
        setMode(s.auth ?? "password");
      })
      .catch(() => setMode("password"));
  }, [router]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post<{ csrf_token: string }>("/auth/login", { username, password });
      setCsrf(r.csrf_token);
      router.replace("/");
    } catch (err) {
      const ae = err as ApiError;
      if (ae.code === "SETUP_REQUIRED") return router.replace("/setup");
      setError(ae);
    } finally {
      setBusy(false);
    }
  };
  if (!mode) {
    return (
      <AuthLayout title="Sign in" subtitle="">
        <CardSkeleton lines={2} label="sign-in" />
      </AuthLayout>
    );
  }
  if (mode === "google") {
    return (
      <AuthLayout title="Sign in" subtitle="Use the Google account that owns this Jonathon.">
        <div className="space-y-5">
          {returned && <Notice tone="warning">{returned}</Notice>}
          <GoogleSignInButton />
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="Sign in" subtitle="Enter the local account's username and password.">
      <form onSubmit={submit} className="space-y-5">
        <Field label="Username">
          {(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />}
        </Field>
        <Field label="Password">
          {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}
        </Field>
        <ErrorBanner error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
