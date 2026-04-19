import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Button } from '../components/ui/Button';

export function Login() {
  const login = useAuthStore((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      await login(email, password);
      nav('/');
    } catch (error) {
      setErr((error as Error).message ?? 'login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-neutral-950">
      <form
        onSubmit={submit}
        className="surface rounded-xl w-[360px] p-6 space-y-4"
      >
        <div className="flex items-center gap-2 mb-2">
          <div className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight">Argus</h1>
        </div>
        <p className="text-xs text-neutral-500 -mt-2">
          Agent management · multi-machine control plane
        </p>

        <Field label="Email">
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="input"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="input"
          />
        </Field>
        {err && <p className="text-xs text-red-400">{err}</p>}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'signing in…' : 'sign in'}
        </Button>
      </form>
      <style>{`
        .input {
          width: 100%;
          background: transparent;
          border: 1px solid rgb(38 38 38);
          border-radius: 6px;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: #fafafa;
        }
        .input:focus { outline: none; border-color: rgb(82 82 82); }
      `}</style>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
