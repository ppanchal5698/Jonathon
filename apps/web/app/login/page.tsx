"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { Button, ErrorBanner, Field, Input } from "@/components/ui";
import { type ApiError, post, setCsrf } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
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
  return (
    <AuthLayout title="Sign in" subtitle="Enter the local account's username and password.">
      <form onSubmit={submit} className="space-y-5">
        <Field label="Username">{(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}</Field>
        <ErrorBanner error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
