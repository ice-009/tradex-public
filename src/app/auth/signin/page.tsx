"use client";

import { useState } from "react";
import { signIn, getSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError("Invalid credentials");
    } else {
      const session = await getSession();
      if (session?.user) {
        router.push("/");
      }
    }
    setLoading(false);
  };

  return (
    <div className="app-screen auth-shell">
      <div className="auth-card reveal">
        <div className="auth-brand">
          <span className="nav-logo">TX</span>
          Tradex
        </div>
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-sub">Charts, screener and trade setups for NSE stocks and futures.</p>

        <div className="panel">
          <form onSubmit={handleSubmit} className="auth-form">
            {error && (
              <div className="auth-error" role="alert">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="email" className="control-label">Email</label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="control-input"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="control-label">Password</label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="control-input"
                placeholder="••••••••"
              />
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary w-full">
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>

        <p className="auth-foot">
          Don&apos;t have an account? <Link href="/auth/signup">Sign up</Link>
        </p>
      </div>
    </div>
  );
}
