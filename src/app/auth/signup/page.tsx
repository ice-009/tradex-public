"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icons } from "@/terminal/icons";

export default function SignUp() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const response = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });

    const data = await response.json();

    if (response.ok) {
      setSuccess(true);
      setTimeout(() => router.push("/auth/signin"), 2000);
    } else {
      setError(data.error);
    }
    setLoading(false);
  };

  if (success) {
    return (
      <div className="app-screen auth-shell">
        <div className="auth-card auth-success reveal">
          <div className="auth-success-icon">
            <Icons.check size={20} />
          </div>
          <h1 className="auth-title">Account created</h1>
          <p className="auth-sub">Taking you to sign in…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-screen auth-shell">
      <div className="auth-card reveal">
        <div className="auth-brand">
          <span className="nav-logo">TX</span>
          Tradex
        </div>
        <h1 className="auth-title">Create your account</h1>
        <p className="auth-sub">Charts, screener and trade setups for NSE stocks and futures.</p>

        <div className="panel">
          <form onSubmit={handleSubmit} className="auth-form">
            {error && (
              <div className="auth-error" role="alert">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="name" className="control-label">Full name</label>
              <input
                id="name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="control-input"
                placeholder="Your name"
              />
            </div>

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
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="control-input"
                placeholder="At least 6 characters"
              />
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary w-full">
              {loading ? "Creating account…" : "Create account"}
            </button>
          </form>
        </div>

        <p className="auth-foot">
          Already have an account? <Link href="/auth/signin">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
